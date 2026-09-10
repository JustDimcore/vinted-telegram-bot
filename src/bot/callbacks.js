import { InlineKeyboard } from 'grammy';
import crud from '../crud.js';
import Logger from '../utils/logger.js';
import { Preference } from '../database.js';
import { renderSubscriptionList, renderSubscriptionDetail } from './components/subscription_view.js';
import { renderSettings } from './components/settings_view.js';
import { escapeHtml } from './components/item_message.js';
import { startFlow, registerFlow, clearFlow } from './wizard.js';
import { runBroadcast, cancelBroadcast } from './commands/admin_broadcast.js';

/**
 * Replaces the message a button belongs to, ignoring the "nothing changed" answer of Telegram.
 * @param {Object} ctx - Telegram context.
 * @param {string} text - New HTML text.
 * @param {InlineKeyboard} keyboard - New keyboard.
 * @returns {Promise<void>}
 */
async function replaceMessage(ctx, text, keyboard) {
    try {
        await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: keyboard,
        });
    } catch (error) {
        // Editing a message into exactly the same content is an error for Telegram, not for us.
        if (!String(error.description || error.message).includes('message is not modified')) {
            throw error;
        }
    }
}

/**
 * Loads a subscription and verifies that the user may act on it.
 * @param {Object} ctx - Telegram context.
 * @param {string} subscriptionId - Subscription identifier.
 * @returns {Promise<Object|null>} - The subscription, or null when it is not accessible.
 */
async function loadOwnedSubscription(ctx, subscriptionId) {
    const subscription = await crud.getSubscriptionById(subscriptionId);

    if (!subscription) {
        await ctx.answerCallbackQuery({ text: ctx.t('subscription-not-found'), show_alert: true });
        return null;
    }

    const ownerId = subscription.user?.telegramId;
    if (ownerId !== String(ctx.from.id) && !ctx.isAdmin) {
        await ctx.answerCallbackQuery({ text: ctx.t('not-your-subscription'), show_alert: true });
        return null;
    }

    return subscription;
}

/**
 * Redraws the list of subscriptions of the current user.
 * @param {Object} ctx - Telegram context.
 * @returns {Promise<void>}
 */
async function showList(ctx) {
    const user = await crud.getUserByTelegramId(ctx.from.id);
    const subscriptions = await crud.getSubscriptionsByTelegramId(ctx.from.id);
    const { text, keyboard } = renderSubscriptionList({ user, subscriptions, lang: ctx.lang });
    await replaceMessage(ctx, text, keyboard);
}

/**
 * Redraws one subscription.
 * @param {Object} ctx - Telegram context.
 * @param {Object} subscription - The subscription.
 * @returns {Promise<void>}
 */
async function showDetail(ctx, subscription) {
    const { text, keyboard } = renderSubscriptionDetail({ subscription, lang: ctx.lang });
    await replaceMessage(ctx, text, keyboard);
}

/**
 * Routes a pressed inline button to its action.
 * @param {Object} ctx - Telegram context of the callback query.
 * @returns {Promise<void>}
 */
export async function handleCallback(ctx) {
    const data = ctx.callbackQuery.data;
    const separator = data.indexOf(':');
    const action = separator === -1 ? data : data.slice(0, separator);
    const payload = separator === -1 ? '' : data.slice(separator + 1);

    Logger.debug(`Callback ${action} from ${ctx.from.id}`);

    try {
        switch (action) {
            case 'noop': {
                await ctx.answerCallbackQuery();
                break;
            }

            case 'list': {
                await showList(ctx);
                await ctx.answerCallbackQuery();
                break;
            }

            case 'sub': {
                const subscription = await loadOwnedSubscription(ctx, payload);
                if (!subscription) {
                    break;
                }
                await showDetail(ctx, subscription);
                await ctx.answerCallbackQuery();
                break;
            }

            case 'pause':
            case 'resume': {
                const subscription = await loadOwnedSubscription(ctx, payload);
                if (!subscription) {
                    break;
                }

                const updated = action === 'pause'
                    ? await crud.stopSubscriptionMonitoring(payload)
                    : await crud.startSubscriptionMonitoring(payload);

                await showDetail(ctx, await crud.getSubscriptionById(updated.subscriptionId));
                await ctx.answerCallbackQuery({ text: ctx.t(action === 'pause' ? 'monitoring-stopped' : 'monitoring-started') });
                break;
            }

            case 'del': {
                const subscription = await loadOwnedSubscription(ctx, payload);
                if (!subscription) {
                    break;
                }

                const keyboard = new InlineKeyboard()
                    .text(`🗑 ${ctx.t('yes-delete')}`, `delok:${payload}`)
                    .text(`↩️ ${ctx.t('cancel')}`, `sub:${payload}`);

                await replaceMessage(ctx, ctx.t('delete-confirm', { name: escapeHtml(subscription.name) }), keyboard);
                await ctx.answerCallbackQuery();
                break;
            }

            case 'delok': {
                const subscription = await loadOwnedSubscription(ctx, payload);
                if (!subscription) {
                    break;
                }

                await crud.deleteSubscription(payload);
                await showList(ctx);
                await ctx.answerCallbackQuery({ text: ctx.t('subscription-deleted') });
                break;
            }

            case 'bcast_go': {
                if (!ctx.isAdmin) {
                    await ctx.answerCallbackQuery({ text: ctx.t('not-authorized'), show_alert: true });
                    break;
                }
                await runBroadcast(ctx);
                break;
            }

            case 'bcast_no': {
                cancelBroadcast(ctx);
                await replaceMessage(ctx, ctx.t('broadcast-cancelled'), new InlineKeyboard());
                await ctx.answerCallbackQuery();
                break;
            }

            case 'wipeok': {
                const deleted = await crud.deleteAllSubscriptionsOfUser(ctx.from.id);
                await replaceMessage(ctx, ctx.t('all-subscriptions-deleted', { count: deleted }), new InlineKeyboard());
                await ctx.answerCallbackQuery();
                break;
            }

            case 'keywords': {
                const subscription = await loadOwnedSubscription(ctx, payload);
                if (!subscription) {
                    break;
                }

                startFlow(ctx, 'keywords', 'input', { subscriptionId: payload });
                await ctx.reply(ctx.t('ask-banned-keywords-edit', {
                    current: escapeHtml((subscription.bannedKeywords || []).join(', ')) || '—',
                }), { parse_mode: 'HTML' });
                await ctx.answerCallbackQuery();
                break;
            }

            case 'silent': {
                await crud.setUserPreference(ctx.from.id, Preference.Silent, payload === '1');
                const user = await crud.getUserByTelegramId(ctx.from.id);
                const { text, keyboard } = renderSettings({ user, lang: ctx.lang });
                await replaceMessage(ctx, text, keyboard);
                await ctx.answerCallbackQuery();
                break;
            }

            case 'lang': {
                await crud.setUserPreference(ctx.from.id, Preference.Language, payload === 'auto' ? null : payload);
                const user = await crud.getUserByTelegramId(ctx.from.id);
                // The new language applies immediately, so the redrawn message uses it.
                const lang = payload === 'auto' ? ctx.lang : payload;
                const { text, keyboard } = renderSettings({ user, lang });
                await replaceMessage(ctx, text, keyboard);
                await ctx.answerCallbackQuery();
                break;
            }

            // Answers to the inactivity question.
            case 'keep': {
                const subscription = await loadOwnedSubscription(ctx, payload);
                if (!subscription) {
                    break;
                }

                await crud.setSubscriptionUpdatedAtNow(payload);
                await crud.setSubscriptionKeepMessageSent(payload, false);
                await replaceMessage(ctx, ctx.t('subscription-kept', { name: escapeHtml(subscription.name) }), new InlineKeyboard());
                await ctx.answerCallbackQuery();
                break;
            }

            case 'drop': {
                const subscription = await loadOwnedSubscription(ctx, payload);
                if (!subscription) {
                    break;
                }

                await crud.deleteSubscription(payload);
                await replaceMessage(ctx, ctx.t('subscription-deleted'), new InlineKeyboard());
                await ctx.answerCallbackQuery();
                break;
            }

            default: {
                await ctx.answerCallbackQuery({ text: ctx.t('unknown-action') });
            }
        }
    } catch (error) {
        Logger.error(`Error handling callback ${data}: ${error.message}`);
        try {
            await ctx.answerCallbackQuery({ text: ctx.t('generic-error'), show_alert: true });
        } catch (answerError) {
            Logger.debug(`Could not answer the callback query: ${answerError.message}`);
        }
    }
}

// Editing the banned keywords of a subscription: the button above asks the question,
// the answer arrives as an ordinary message and lands here.
registerFlow('keywords', async (ctx, state) => {
    const answer = ctx.message.text.trim();
    clearFlow(ctx);

    const subscription = await crud.getSubscriptionById(state.data.subscriptionId);
    if (!subscription) {
        await ctx.reply(ctx.t('subscription-not-found'));
        return;
    }

    if (subscription.user?.telegramId !== String(ctx.from.id) && !ctx.isAdmin) {
        await ctx.reply(ctx.t('not-your-subscription'));
        return;
    }

    // A dash clears the list, anything else is a comma separated list of keywords.
    const keywords = ['-', '—'].includes(answer)
        ? []
        : answer.split(',').map(keyword => keyword.trim()).filter(Boolean);

    await crud.setSubscriptionBannedKeywords(subscription.subscriptionId, keywords);

    const updated = await crud.getSubscriptionById(subscription.subscriptionId);
    const { text, keyboard } = renderSubscriptionDetail({ subscription: updated, lang: ctx.lang });
    await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: keyboard });
});
