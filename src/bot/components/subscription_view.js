import { InlineKeyboard } from 'grammy';
import t from '../../t.js';
import { escapeHtml, truncate } from './item_message.js';
import { describeFilters, getDomainFromUrl } from '../../services/url_service.js';

// A Telegram message holds 4096 characters and a keyboard stays usable only so long.
// Anyone past this many searches gets a count instead of the rest of the list.
const MAX_LISTED = 25;

/**
 * Renders the overview of every subscription of a user.
 * @param {Object} params - Rendering parameters.
 * @param {Object} params.user - The owner.
 * @param {Array<Object>} params.subscriptions - Subscriptions of the owner.
 * @param {string} params.lang - Language of the recipient.
 * @returns {{text: string, keyboard: InlineKeyboard}} - Message and buttons.
 */
export function renderSubscriptionList({ user, subscriptions, lang }) {
    const keyboard = new InlineKeyboard();

    if (subscriptions.length === 0) {
        return {
            text: `<b>${escapeHtml(t(lang, 'your-subscriptions'))}</b>\n\n${escapeHtml(t(lang, 'no-subscriptions'))}`,
            keyboard,
        };
    }

    const lines = [
        `<b>${escapeHtml(t(lang, 'your-subscriptions'))}</b>`,
        escapeHtml(t(lang, 'subscription-count', { used: subscriptions.length, limit: user.maxSubscriptions })),
        '',
    ];

    subscriptions.slice(0, MAX_LISTED).forEach((subscription, index) => {
        const status = subscription.isMonitoring ? '🟢' : '⏸';
        lines.push(`${status} <b>${index + 1}. ${escapeHtml(truncate(subscription.name, 60))}</b>`);
        lines.push(`    <code>${escapeHtml(describeFilters(subscription.url, lang))}</code>`);
        lines.push(`    ${escapeHtml(t(lang, 'items-found', { count: subscription.itemsFound }))}`);
        lines.push('');

        keyboard.text(`${status} ${truncate(subscription.name, 24)}`, `sub:${subscription.subscriptionId}`).row();
    });

    if (subscriptions.length > MAX_LISTED) {
        lines.push(escapeHtml(t(lang, 'and-more', { count: subscriptions.length - MAX_LISTED })));
    }

    return { text: lines.join('\n'), keyboard };
}

/**
 * Renders one subscription with its actions.
 * @param {Object} params - Rendering parameters.
 * @param {Object} params.subscription - The subscription.
 * @param {string} params.lang - Language of the recipient.
 * @returns {{text: string, keyboard: InlineKeyboard}} - Message and buttons.
 */
export function renderSubscriptionDetail({ subscription, lang }) {
    const id = subscription.subscriptionId;
    const domain = getDomainFromUrl(subscription.url);
    const banned = (subscription.bannedKeywords || []).join(', ');

    const lines = [
        `<b>${escapeHtml(subscription.name)}</b>`,
        '',
        `${escapeHtml(t(lang, 'status'))}: ${subscription.isMonitoring ? '🟢 ' + escapeHtml(t(lang, 'running')) : '⏸ ' + escapeHtml(t(lang, 'paused'))}`,
        `${escapeHtml(t(lang, 'marketplace'))}: <code>vinted.${escapeHtml(domain)}</code>`,
        `${escapeHtml(t(lang, 'filters'))}: <code>${escapeHtml(describeFilters(subscription.url, lang))}</code>`,
        `${escapeHtml(t(lang, 'banned-keywords'))}: <code>${escapeHtml(banned || '—')}</code>`,
        `${escapeHtml(t(lang, 'items-found', { count: subscription.itemsFound }))}`,
        '',
        `<a href="${escapeHtml(subscription.url)}">${escapeHtml(t(lang, 'open-search'))}</a>`,
    ];

    const keyboard = new InlineKeyboard();

    if (subscription.isMonitoring) {
        keyboard.text(`⏸ ${t(lang, 'pause')}`, `pause:${id}`);
    } else {
        keyboard.text(`▶️ ${t(lang, 'resume')}`, `resume:${id}`);
    }

    keyboard.text(`🗑 ${t(lang, 'delete')}`, `del:${id}`).row();
    keyboard.text(`🚫 ${t(lang, 'edit-banned-keywords')}`, `keywords:${id}`).row();
    keyboard.text(`⬅️ ${t(lang, 'back')}`, 'list');

    return { text: lines.join('\n'), keyboard };
}
