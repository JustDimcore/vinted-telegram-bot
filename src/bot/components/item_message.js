import { InlineKeyboard } from 'grammy';
import t from '../../t.js';

// Telegram truncates a photo caption at 1024 characters and a text message at 4096.
const CAPTION_LIMIT = 1024;
const TEXT_LIMIT = 4096;

/**
 * Escapes the characters that Telegram HTML parsing would swallow.
 * @param {any} value - Value to escape.
 * @returns {string} - Escaped text.
 */
export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Shortens a text to a maximum length, cutting on a word boundary when possible.
 * @param {string} text - Text to shorten.
 * @param {number} max - Maximum length.
 * @returns {string} - Shortened text.
 */
function truncate(text, max) {
    if (text.length <= max) {
        return text;
    }

    const cut = text.slice(0, max - 1);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Replaces the Vinted domain in a URL, so the links point at the marketplace of the search.
 * @param {string} url - Original URL.
 * @param {string} domain - Domain extension, for example "fr" or "co.uk".
 * @returns {string} - URL on the requested domain.
 */
export function replaceDomainInUrl(url, domain) {
    if (!url || url === 'N/A') {
        return url;
    }

    return url.replace(/vinted\.(.*?)\//, `vinted.${domain}/`);
}

/**
 * Renders a Vinted rating as stars.
 * @param {number} rating - Rating between 0 and 1.
 * @returns {string} - Star string.
 */
function getStars(rating) {
    const rounded = Math.round(rating * 5);
    return '⭐️'.repeat(Math.max(0, Math.min(5, rounded)));
}

/**
 * Formats how long ago a timestamp was, in the language of the recipient.
 * @param {number} unixSeconds - Unix timestamp in seconds.
 * @param {string} lang - Language code.
 * @returns {string|null} - Human readable distance, null when the timestamp is unusable.
 */
function formatRelativeTime(unixSeconds, lang) {
    if (!unixSeconds || unixSeconds <= 0) {
        return null;
    }

    const diffSeconds = Math.round((unixSeconds * 1000 - Date.now()) / 1000);
    const units = [
        ['day', 86400],
        ['hour', 3600],
        ['minute', 60],
        ['second', 1],
    ];

    try {
        const formatter = new Intl.RelativeTimeFormat(lang || 'en', { numeric: 'auto' });
        for (const [unit, seconds] of units) {
            if (Math.abs(diffSeconds) >= seconds || unit === 'second') {
                return formatter.format(Math.round(diffSeconds / seconds), unit);
            }
        }
    } catch (error) {
        return null;
    }

    return null;
}

/**
 * Builds the caption of an item notification.
 * @param {Object} params - Rendering parameters.
 * @param {import('../../entities/vinted_item.js').VintedItem} params.item - The item.
 * @param {string} params.domain - Vinted domain extension of the search.
 * @param {string} params.lang - Language of the recipient.
 * @param {string} [params.subscriptionName] - Name of the subscription that found the item.
 * @param {boolean} [params.withLinks] - Append the links, used when no buttons can be attached.
 * @param {number} [params.limit] - Maximum length of the result.
 * @returns {string} - HTML formatted caption.
 */
export function buildItemCaption({ item, domain, lang, subscriptionName, withLinks = false, limit = CAPTION_LIMIT }) {
    const itemUrl = replaceDomainInUrl(item.url, domain);
    const lines = [];

    lines.push(`<b>${escapeHtml(truncate(item.title, 120))}</b>`);

    const price = item.priceNumeric
        ? `💰 <b>${escapeHtml(item.priceNumeric)} ${escapeHtml(item.currency)}</b>`
        : null;
    // The total price includes the buyer protection fee and is what the buyer really pays.
    const totalPrice = item.totalPriceNumeric && item.totalPriceNumeric !== item.priceNumeric
        ? `(${escapeHtml(item.totalPriceNumeric)} ${escapeHtml(item.currency)} ${escapeHtml(t(lang, 'total-price'))})`
        : null;

    if (price) {
        lines.push([price, totalPrice].filter(Boolean).join(' '));
    }

    const facts = [];
    if (item.size && item.size !== 'N/A') {
        facts.push(`📏 ${escapeHtml(item.size)}`);
    }
    if (item.brand && item.brand !== 'N/A') {
        facts.push(`🏷 ${escapeHtml(item.brand)}`);
    }
    if (item.status && item.status !== 'N/A') {
        facts.push(`📦 ${escapeHtml(item.status)}`);
    }
    if (facts.length) {
        lines.push(facts.join('  ·  '));
    }

    const rating = item.user ? item.user.feedback_reputation : 0;
    if (rating > 0) {
        const roundedRating = Math.round(rating * 50) / 10;
        lines.push(`${getStars(rating)} ${roundedRating} (${item.user.feedback_count})`);
    }

    const updated = formatRelativeTime(item.unixUpdatedAt, lang);
    if (updated) {
        lines.push(`🕒 ${escapeHtml(updated)}`);
    }

    if (subscriptionName) {
        lines.push(`🔔 ${escapeHtml(truncate(subscriptionName, 60))}`);
    }

    if (withLinks && itemUrl !== 'N/A') {
        lines.push(`\n<a href="${escapeHtml(itemUrl)}">${escapeHtml(t(lang, 'open-on-vinted'))}</a>`);
    }

    const head = lines.join('\n');

    // Whatever is left of the caption budget goes to the description.
    const hasDescription = item.description && item.description !== 'N/A';
    if (!hasDescription) {
        return truncate(head, limit);
    }

    const remaining = limit - head.length - 6;
    if (remaining < 40) {
        return truncate(head, limit);
    }

    const description = escapeHtml(truncate(item.description.replace(/\s+/g, ' ').trim(), remaining));
    return `${head}\n\n📝 ${description}`;
}

/**
 * Builds the buttons below a single photo notification.
 * @param {Object} item - The item.
 * @param {string} domain - Vinted domain extension of the search.
 * @param {string} lang - Language of the recipient.
 * @returns {InlineKeyboard} - Keyboard with the links.
 */
export function buildItemKeyboard(item, domain, lang) {
    const keyboard = new InlineKeyboard();
    const itemUrl = replaceDomainInUrl(item.url, domain);

    if (itemUrl && itemUrl !== 'N/A') {
        keyboard.url(`🔗 ${t(lang, 'open-on-vinted')}`, itemUrl);
    }

    const sellerUrl = item.user ? replaceDomainInUrl(item.user.url, domain) : null;
    if (sellerUrl && sellerUrl !== 'N/A') {
        keyboard.url(`👤 ${t(lang, 'seller')}`, sellerUrl);
    }

    return keyboard;
}

/**
 * Builds the album entries of an item.
 * @param {Object} item - The item.
 * @param {string} caption - Caption for the first photo.
 * @param {number} maxPhotos - How many photos to include.
 * @returns {Array<Object>} - Media group entries.
 */
export function buildItemMediaGroup(item, caption, maxPhotos) {
    return item.getPhotoUrls(maxPhotos).map((url, index) => ({
        type: 'photo',
        media: url,
        ...(index === 0 ? { caption, parse_mode: 'HTML' } : {}),
    }));
}

export { CAPTION_LIMIT, TEXT_LIMIT, truncate };
