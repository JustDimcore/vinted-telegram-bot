import crud from '../../crud.js';
import ConfigurationManager from '../../utils/config_manager.js';
import { escapeHtml } from '../components/item_message.js';

export const command = 'info';
export const description = 'cmd-info';
export const order = 6;

const algorithmSettings = ConfigurationManager.getAlgorithmSetting;

/**
 * Shows the account of the user and what the bot currently does for them.
 * @param {Object} ctx - Telegram context.
 * @returns {Promise<void>}
 */
export async function execute(ctx) {
    const user = await crud.getUserByTelegramId(ctx.from.id);
    const subscriptions = await crud.getSubscriptionsByTelegramId(ctx.from.id);
    const active = subscriptions.filter(subscription => subscription.isMonitoring).length;
    const itemsFound = subscriptions.reduce((total, subscription) => total + (subscription.itemsFound || 0), 0);

    const lines = [
        `<b>${escapeHtml(ctx.t('your-account'))}</b>`,
        '',
        `${escapeHtml(ctx.t('telegram-id'))}: <code>${escapeHtml(user.telegramId)}</code>`,
        `${escapeHtml(ctx.t('subscription-limit'))}: <b>${subscriptions.length} / ${user.maxSubscriptions}</b>`,
        `${escapeHtml(ctx.t('active-subscriptions'))}: <b>${active}</b>`,
        `${escapeHtml(ctx.t('items-found-total'))}: <b>${itemsFound}</b>`,
        '',
        `${escapeHtml(ctx.t('check-interval'))}: <b>${algorithmSettings.monitor_interval_seconds}–${Math.round(algorithmSettings.monitor_interval_max_seconds)}s</b>`,
        `${escapeHtml(ctx.t('default-marketplace'))}: <code>vinted.${escapeHtml(algorithmSettings.vinted_api_domain_extension)}</code>`,
    ];

    if (ctx.isAdmin) {
        lines.push('', `👑 ${escapeHtml(ctx.t('you-are-admin'))}`);
    }

    await ctx.reply(lines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
    });
}
