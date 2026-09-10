import crud from '../../crud.js';
import Logger from '../../utils/logger.js';
import ConfigurationManager from '../../utils/config_manager.js';
import { Preference, ShippableMap } from '../../database.js';
import { buildApiFiltersFromUrl, hasAnyFilter, getDomainFromUrl, getMarketplaceKey } from '../../services/url_service.js';
import { renderSubscriptionDetail } from '../components/subscription_view.js';
import { escapeHtml } from '../components/item_message.js';
import { startFlow, setStep, clearFlow, registerFlow } from '../wizard.js';

export const command = 'add';
export const description = 'cmd-add';
export const order = 3;

const permissionConfig = ConfigurationManager.getPermissionConfig;

// A monitored URL has to be a catalog search - an item page or a member profile
// carries no filters the catalog API could be asked with.
const VALID_ROUTE = 'catalog';
const MAX_NAME_LENGTH = 64;
const SKIP_TOKENS = ['-', '—', 'skip'];

/**
 * Validates a Vinted catalog URL.
 * @param {string} url - URL entered by the user.
 * @returns {true|string} - True, or the translation key of the problem.
 */
function validateUrl(url) {
    let parsed;

    try {
        parsed = new URL(url);
    } catch (error) {
        return 'invalid-url';
    }

    if (!/(^|\.)vinted\./.test(parsed.hostname)) {
        return 'not-a-vinted-url';
    }

    if (parsed.pathname.split('/').pop() !== VALID_ROUTE) {
        return 'invalid-url-with-example';
    }

    if (parsed.searchParams.toString().length === 0) {
        return 'must-have-query-params';
    }

    // Without a single supported filter the search would cover all of Vinted and
    // flood the chat, so an empty catalog URL is rejected.
    if (!hasAnyFilter(buildApiFiltersFromUrl(url))) {
        return 'must-have-supported-filter';
    }

    return true;
}

/**
 * Suggests a name for a search, taken from its own filters.
 * @param {string} url - Vinted URL.
 * @param {number} index - Position in the list of the user.
 * @returns {string} - Suggested name.
 */
function suggestName(url, index) {
    try {
        const searchText = new URL(url).searchParams.get('search_text');
        if (searchText) {
            return searchText.slice(0, MAX_NAME_LENGTH);
        }
    } catch (error) {
        Logger.debug(`Could not read a name out of ${url}`);
    }

    return `Search ${index}`;
}

/**
 * Checks whether the user may create another subscription.
 * @param {Object} ctx - Telegram context.
 * @returns {Promise<string|null>} - Translation key of the problem, or null.
 */
async function checkQuota(ctx) {
    if (!permissionConfig.allow_user_to_create_subscriptions && !ctx.isAdmin) {
        return 'not-allowed-to-create-subscriptions';
    }

    const user = await crud.getUserByTelegramId(ctx.from.id);
    if (!ctx.isAdmin && user.subscriptions.length >= user.maxSubscriptions) {
        return 'subscription-limit-exceeded';
    }

    return null;
}

/**
 * Starts the dialog, or takes the URL straight from the command arguments.
 * @param {Object} ctx - Telegram context.
 * @returns {Promise<void>}
 */
export async function execute(ctx) {
    const problem = await checkQuota(ctx);
    if (problem) {
        const user = await crud.getUserByTelegramId(ctx.from.id);
        await ctx.reply(ctx.t(problem, { limit: user.maxSubscriptions }));
        return;
    }

    const argument = (ctx.match || '').trim();

    if (!argument) {
        startFlow(ctx, 'add', 'url');
        await ctx.reply(ctx.t('ask-url'), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
        return;
    }

    const validation = validateUrl(argument);
    if (validation !== true) {
        await ctx.reply(ctx.t(validation), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
        return;
    }

    startFlow(ctx, 'add', 'name', { url: argument });
    await askForName(ctx, argument);
}

/**
 * Asks for the name of the search and offers a suggestion.
 * @param {Object} ctx - Telegram context.
 * @param {string} url - Validated URL.
 * @returns {Promise<void>}
 */
async function askForName(ctx, url) {
    const subscriptions = await crud.getSubscriptionsByTelegramId(ctx.from.id);
    const suggestion = suggestName(url, subscriptions.length + 1);

    setStep(ctx, 'name', { suggestion });
    await ctx.reply(ctx.t('ask-name', { suggestion: escapeHtml(suggestion) }), { parse_mode: 'HTML' });
}

/**
 * Creates the subscription once every answer is in.
 * @param {Object} ctx - Telegram context.
 * @param {Object} data - Collected answers.
 * @returns {Promise<void>}
 */
async function createSubscription(ctx, data) {
    const user = await crud.getUserByTelegramId(ctx.from.id);
    const domain = getDomainFromUrl(data.url);
    const marketplace = getMarketplaceKey(domain);

    const subscription = await crud.createSubscription({
        name: data.name,
        url: data.url,
        chatId: ctx.chat.id,
        // In a forum group the notifications stay in the topic the command was sent from.
        threadId: ctx.message?.message_thread_id ?? null,
        bannedKeywords: data.bannedKeywords ?? [],
        user,
    });

    // Kept from the Discord original: which countries can ship to this marketplace.
    const shippable = ShippableMap[marketplace] ?? [];
    await crud.setSubscriptionPreference(subscription.subscriptionId, Preference.Countries, [...shippable, marketplace]);

    const created = await crud.getSubscriptionById(subscription.subscriptionId);
    const { text, keyboard } = renderSubscriptionDetail({ subscription: created, lang: ctx.lang });

    await ctx.reply(`✅ <b>${escapeHtml(ctx.t('subscription-created'))}</b>\n\n${text}`, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard,
    });

    Logger.info(`User ${ctx.from.id} created subscription "${data.name}"`);
}

// The dialog: URL, then name, then the banned keywords.
registerFlow('add', async (ctx, state) => {
    const answer = ctx.message.text.trim();

    if (state.step === 'url') {
        const validation = validateUrl(answer);
        if (validation !== true) {
            await ctx.reply(ctx.t(validation), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
            return;
        }

        setStep(ctx, 'name', { url: answer });
        await askForName(ctx, answer);
        return;
    }

    if (state.step === 'name') {
        const name = SKIP_TOKENS.includes(answer.toLowerCase())
            ? state.data.suggestion
            : answer.slice(0, MAX_NAME_LENGTH);

        setStep(ctx, 'keywords', { name });
        await ctx.reply(ctx.t('ask-banned-keywords'), { parse_mode: 'HTML' });
        return;
    }

    if (state.step === 'keywords') {
        const bannedKeywords = SKIP_TOKENS.includes(answer.toLowerCase())
            ? []
            : answer.split(',').map(keyword => keyword.trim()).filter(Boolean);

        clearFlow(ctx);

        // The quota is checked again: the dialog may have been open for a while.
        const problem = await checkQuota(ctx);
        if (problem) {
            const user = await crud.getUserByTelegramId(ctx.from.id);
            await ctx.reply(ctx.t(problem, { limit: user.maxSubscriptions }));
            return;
        }

        await createSubscription(ctx, { ...state.data, bannedKeywords });
    }
});
