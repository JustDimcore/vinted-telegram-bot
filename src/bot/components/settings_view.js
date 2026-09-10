import { InlineKeyboard } from 'grammy';
import t from '../../t.js';
import LanguageService from '../../utils/language.js';
import { Preference } from '../../database.js';
import { escapeHtml } from './item_message.js';

/**
 * Renders the settings of a user.
 * @param {Object} params - Rendering parameters.
 * @param {Object} params.user - The user.
 * @param {string} params.lang - Language of the recipient.
 * @returns {{text: string, keyboard: InlineKeyboard}} - Message and buttons.
 */
export function renderSettings({ user, lang }) {
    const silent = Boolean(user.preferences.get(Preference.Silent));
    const language = user.preferences.get(Preference.Language) || t(lang, 'automatic');

    const text = [
        `<b>${escapeHtml(t(lang, 'settings'))}</b>`,
        '',
        `🔕 ${escapeHtml(t(lang, 'silent-notifications'))}: <b>${escapeHtml(t(lang, silent ? 'enabled' : 'disabled'))}</b>`,
        `🌍 ${escapeHtml(t(lang, 'language'))}: <b>${escapeHtml(language)}</b>`,
        `📦 ${escapeHtml(t(lang, 'subscription-limit'))}: <b>${user.subscriptions.length} / ${user.maxSubscriptions}</b>`,
    ].join('\n');

    const keyboard = new InlineKeyboard()
        .text(silent ? `🔔 ${t(lang, 'turn-notifications-on')}` : `🔕 ${t(lang, 'turn-notifications-off')}`, `silent:${silent ? 0 : 1}`)
        .row();

    // One button per loaded locale, plus the automatic choice that follows the Telegram client.
    keyboard.text(`🌍 ${t(lang, 'automatic')}`, 'lang:auto');
    for (const locale of LanguageService.available()) {
        keyboard.text(locale, `lang:${locale}`);
    }

    return { text, keyboard };
}
