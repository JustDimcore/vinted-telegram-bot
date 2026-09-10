import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Bot, GrammyError, HttpError } from 'grammy';

import ConfigurationManager from '../utils/config_manager.js';
import Logger from '../utils/logger.js';
import LanguageService from '../utils/language.js';
import crud from '../crud.js';
import { Preference } from '../database.js';
import t from '../t.js';
import { dispatchFlow } from './wizard.js';
import { handleCallback } from './callbacks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const telegramConfig = ConfigurationManager.getTelegramConfig;

if (!telegramConfig.token || telegramConfig.token === 'YOUR_BOT_TOKEN') {
    Logger.error('TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and put its token into .env');
    process.exit(1);
}

const bot = new Bot(telegramConfig.token);

/**
 * Loads the command modules from the commands folder.
 * Every module exports { command, description, adminOnly?, hidden?, execute }.
 * @returns {Promise<Array<Object>>} - The loaded commands.
 */
async function loadCommands() {
    const files = fs.readdirSync(path.join(__dirname, 'commands')).filter(file => file.endsWith('.js'));
    const commands = [];

    for (const file of files) {
        const module = await import(`./commands/${file}`);
        if (!module.command || typeof module.execute !== 'function') {
            Logger.warn(`Skipping command file ${file}: it exports no command`);
            continue;
        }
        commands.push(module);
    }

    return commands.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/**
 * Attaches the database user and the resolved language to the context.
 */
bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) {
        return;
    }

    // Everything the bot offers is bound to a user record, so it is created on first contact.
    ctx.appUser = await crud.getOrCreateUser(ctx.from, ctx.chat?.id ?? ctx.from.id);
    // An explicit choice in /settings wins over the language of the Telegram client.
    const preferredLanguage = ctx.appUser?.preferences?.get(Preference.Language);
    ctx.lang = LanguageService.resolve(preferredLanguage || ctx.from.language_code || ctx.appUser?.languageCode);
    ctx.isAdmin = crud.isUserAdmin(ctx.from.id);
    ctx.t = (key, values) => t(ctx.lang, key, values);

    await next();
});

/**
 * Blocks everyone who is not on the allow list, when one is configured.
 */
bot.use(async (ctx, next) => {
    const allowed = telegramConfig.allowed_user_ids;
    if (allowed.length === 0 || ctx.isAdmin || allowed.includes(String(ctx.from.id))) {
        await next();
        return;
    }

    Logger.warn(`Rejected user ${ctx.from.id} (${ctx.from.username ?? 'no username'}): not on the allow list`);

    if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: ctx.t('not-authorized'), show_alert: true });
        return;
    }

    await ctx.reply(ctx.t('not-authorized'));
});

/**
 * Registers the commands and the generic handlers, and publishes the Telegram command menu.
 *
 * Order matters: grammY runs the middleware in registration order and the catch all text
 * handler below does not call next(), so the commands have to be registered before it.
 * @returns {Promise<void>}
 */
async function setupBot() {
    const commands = await loadCommands();

    for (const module of commands) {
        bot.command(module.command, async ctx => {
            if (module.adminOnly && !ctx.isAdmin) {
                await ctx.reply(ctx.t('not-authorized'));
                return;
            }

            Logger.debug(`Command /${module.command} from ${ctx.from.id}`);
            await module.execute(ctx);
        });
    }

    const menu = commands
        .filter(module => !module.hidden && !module.adminOnly)
        .map(module => ({
            command: module.command,
            // The menu is global, so it is published in the fallback language.
            description: t(LanguageService.fallbackLanguage, module.description),
        }));

    // Buttons of the inline keyboards.
    bot.on('callback_query:data', handleCallback);

    // Anything that is not a command is an answer to a running dialog.
    bot.on('message:text', async ctx => {
        if (ctx.message.text.startsWith('/')) {
            return;
        }

        const handled = await dispatchFlow(ctx);
        if (!handled && ctx.chat.type === 'private') {
            await ctx.reply(ctx.t('unknown-input'), { parse_mode: 'HTML' });
        }
    });

    try {
        await bot.api.setMyCommands(menu);
        Logger.info(`Published ${menu.length} commands in the Telegram menu`);
    } catch (error) {
        Logger.warn(`Could not publish the command menu: ${error.message}`);
    }
}

bot.catch(({ ctx, error }) => {
    const from = ctx?.from?.id ?? 'unknown';

    if (error instanceof GrammyError) {
        Logger.error(`Telegram API error for update from ${from}: ${error.description}`);
    } else if (error instanceof HttpError) {
        Logger.error(`Could not reach Telegram for update from ${from}: ${error.message}`);
    } else {
        Logger.error(`Error handling update from ${from}: ${error?.stack || error}`);
    }
});

export { bot, setupBot };
export default bot;
