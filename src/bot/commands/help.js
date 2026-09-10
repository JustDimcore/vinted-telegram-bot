import { escapeHtml } from '../components/item_message.js';

export const command = 'help';
export const description = 'cmd-help';
export const order = 2;

// Kept in one place so the help text and the command menu cannot drift apart.
const USER_COMMANDS = [
    ['add', 'cmd-add'],
    ['list', 'cmd-list'],
    ['settings', 'cmd-settings'],
    ['info', 'cmd-info'],
    ['delete_all', 'cmd-delete-all'],
    ['cancel', 'cmd-cancel'],
    ['help', 'cmd-help'],
];

const ADMIN_COMMANDS = [
    ['admin_stats', 'cmd-admin-stats'],
    ['admin_setmax', 'cmd-admin-setmax'],
    ['admin_broadcast', 'cmd-admin-broadcast'],
];

/**
 * Lists the available commands and explains how a search URL is built.
 * @param {Object} ctx - Telegram context.
 * @returns {Promise<void>}
 */
export async function execute(ctx) {
    const lines = [`<b>${escapeHtml(ctx.t('help-title'))}</b>`, ''];

    for (const [name, key] of USER_COMMANDS) {
        lines.push(`/${name} — ${escapeHtml(ctx.t(key))}`);
    }

    if (ctx.isAdmin) {
        lines.push('', `<b>${escapeHtml(ctx.t('admin-commands'))}</b>`);
        for (const [name, key] of ADMIN_COMMANDS) {
            lines.push(`/${name} — ${escapeHtml(ctx.t(key))}`);
        }
    }

    lines.push('', `<b>${escapeHtml(ctx.t('help-url-title'))}</b>`, escapeHtml(ctx.t('help-url-body')));
    // The ampersand has to be escaped, Telegram rejects a bare one in HTML mode.
    lines.push('', '<code>https://www.vinted.fr/catalog?brand_ids[]=53&amp;price_to=50</code>');

    await ctx.reply(lines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
    });
}
