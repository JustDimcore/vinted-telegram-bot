import { InlineKeyboard } from 'grammy';
import crud from '../../crud.js';
import Logger from '../../utils/logger.js';
import TelegramService from '../../services/telegram_service.js';
import { registerFlow, startFlow, clearFlow } from '../wizard.js';
import { escapeHtml } from '../components/item_message.js';

export const command = 'admin_broadcast';
export const description = 'cmd-admin-broadcast';
export const adminOnly = true;
export const order = 92;

// A message to every user is not undoable, so the text is previewed and confirmed
// before anything is sent. The pending text is held per admin.
const pending = new Map();

/**
 * Takes the broadcast text and asks for confirmation.
 * @param {Object} ctx - Telegram context.
 * @returns {Promise<void>}
 */
export async function execute(ctx) {
    const text = (ctx.match || '').trim();

    if (!text) {
        startFlow(ctx, 'broadcast', 'text');
        await ctx.reply(ctx.t('admin-broadcast-usage'), { parse_mode: 'HTML' });
        return;
    }

    await confirm(ctx, text);
}

async function confirm(ctx, text) {
    const users = await crud.countUsers();
    pending.set(String(ctx.from.id), text);

    const keyboard = new InlineKeyboard()
        .text(`📢 ${ctx.t('send-to-all', { count: users })}`, 'bcast_go')
        .text(`↩️ ${ctx.t('cancel')}`, 'bcast_no');

    await ctx.reply(
        `<b>${escapeHtml(ctx.t('admin-broadcast-preview'))}</b>\n\n${escapeHtml(text)}`,
        { parse_mode: 'HTML', reply_markup: keyboard }
    );
}

registerFlow('broadcast', async (ctx, state) => {
    clearFlow(ctx);
    await confirm(ctx, ctx.message.text.trim());
});

/**
 * Sends the confirmed broadcast. Delivery goes through the send queue, so a large
 * user base cannot get the bot rate limited.
 * @param {Object} ctx - Telegram context of the confirmation button.
 * @returns {Promise<void>}
 */
export async function runBroadcast(ctx) {
    const text = pending.get(String(ctx.from.id));
    pending.delete(String(ctx.from.id));

    if (!text) {
        await ctx.answerCallbackQuery({ text: ctx.t('nothing-to-send') });
        return;
    }

    const users = await crud.getAllUsers();
    await ctx.answerCallbackQuery({ text: ctx.t('broadcast-started', { count: users.length }) });

    let delivered = 0;
    let failed = 0;

    for (const user of users) {
        try {
            await TelegramService.sendText(user.chatId, escapeHtml(text));
            delivered += 1;
        } catch (error) {
            failed += 1;
            Logger.debug(`Broadcast to ${user.telegramId} failed: ${error.message}`);
        }
    }

    Logger.info(`Broadcast finished: ${delivered} delivered, ${failed} failed`);
    await TelegramService.sendText(ctx.chat.id, ctx.t('broadcast-finished', { delivered, failed }));
}

/**
 * Drops a broadcast that was not confirmed.
 * @param {Object} ctx - Telegram context.
 */
export function cancelBroadcast(ctx) {
    pending.delete(String(ctx.from.id));
}
