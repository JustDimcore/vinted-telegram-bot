import crud from '../../crud.js';
import SubscriptionMonitorService from '../../services/subscription_monitor_service.js';
import { escapeHtml } from '../components/item_message.js';

export const command = 'admin_stats';
export const description = 'cmd-admin-stats';
export const adminOnly = true;
export const order = 90;

/**
 * Shows how much work the bot is doing right now.
 * @param {Object} ctx - Telegram context.
 * @returns {Promise<void>}
 */
export async function execute(ctx) {
    const [users, subscriptions, active] = await Promise.all([
        crud.countUsers(),
        crud.countSubscriptions(),
        crud.countSubscriptions({ isMonitoring: true }),
    ]);

    const uptimeMinutes = Math.floor(process.uptime() / 60);
    const memoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

    const lines = [
        `<b>${escapeHtml(ctx.t('admin-stats-title'))}</b>`,
        '',
        `👤 ${escapeHtml(ctx.t('users'))}: <b>${users}</b>`,
        `🔔 ${escapeHtml(ctx.t('subscriptions'))}: <b>${subscriptions}</b> (${active} ${escapeHtml(ctx.t('running'))})`,
        `⏱ ${escapeHtml(ctx.t('watched-timers'))}: <b>${SubscriptionMonitorService.states.size}</b>`,
        '',
        `🕒 ${escapeHtml(ctx.t('uptime'))}: <b>${uptimeMinutes} min</b>`,
        `💾 ${escapeHtml(ctx.t('memory'))}: <b>${memoryMb} MB</b>`,
    ];

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}
