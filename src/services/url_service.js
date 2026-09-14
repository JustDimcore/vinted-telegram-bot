import { URL } from 'url';
import Logger from '../utils/logger.js';
import ConfigurationManager from '../utils/config_manager.js';
import t from '../t.js';

// Filters that make a search specific enough to monitor. The key is the parameter name in
// the URL, the value the name the catalog API used for it.
const URL_TO_API_FILTER = {
    'catalog[]': 'catalog_ids',
    'brand_ids[]': 'brand_ids',
    'size_ids[]': 'size_ids',
    'status_ids[]': 'status_ids',
    'color_ids[]': 'color_ids',
    'material_ids[]': 'material_ids',
    'video_game_platform_ids[]': 'video_game_platform_ids',
    'search_text': 'search_text',
    'price_from': 'price_from',
    'price_to': 'price_to',
    'currency': 'currency',
};

/**
 * Reads the supported filters of a subscription URL.
 * They only serve to reject a URL without any filter: the catalog page itself is requested
 * with the parameters of the saved URL, and Vinted applies them.
 * @param {string} url - Vinted catalog URL saved for a subscription.
 * @returns {Object|null} - Filters found in the URL, or null for an invalid URL.
 */
export function buildApiFiltersFromUrl(url) {
    let params;
    try {
        params = new URL(url).searchParams;
    } catch (error) {
        Logger.error(`Invalid URL provided: ${error.message}`);
        return null;
    }

    const filters = {};

    for (const [urlKey, apiKey] of Object.entries(URL_TO_API_FILTER)) {
        if (urlKey.endsWith('[]')) {
            const values = params.getAll(urlKey);
            if (values.length) {
                filters[apiKey] = values;
            }
            continue;
        }

        const value = params.get(urlKey);
        if (value !== null && value !== '') {
            filters[apiKey] = value;
        }
    }

    return filters;
}

/**
 * Checks whether the URL narrows the search at all.
 * A subscription without a single filter would watch all of Vinted, flooding both the chat and the site.
 * @param {Object|null} filters - Filters from buildApiFiltersFromUrl.
 * @returns {boolean} - True when at least one filter is present.
 */
export function hasAnyFilter(filters) {
    return Boolean(filters) && Object.keys(filters).length > 0;
}

/**
 * Checks an item against the banned keywords of a subscription.
 *
 * The catalog page carries no description, so the title and the brand are all there is to
 * check. There is deliberately no local re-check of the search text: Vinted already searched
 * with it, and a second, stricter match could only hide items the website does show.
 * @param {Object} item - The item.
 * @param {Array<string>} bannedKeywords - Keywords that must not appear.
 * @returns {boolean} - True when the item contains one of them.
 */
export function containsBannedKeyword(item, bannedKeywords) {
    const text = [item.title, item.brand]
        .filter(value => value && value !== 'N/A')
        .join(' ')
        .toLowerCase();

    return (bannedKeywords || [])
        .map(keyword => keyword.trim().toLowerCase())
        .filter(Boolean)
        .some(keyword => text.includes(keyword));
}

/**
 * Extracts the Vinted domain extension from a URL.
 * Everything after "vinted." is kept, so "www.vinted.co.uk" yields "co.uk" and the
 * links built from it stay valid.
 * @param {string} url - Vinted URL.
 * @returns {string} - Domain extension, falling back to the configured one.
 */
export function getDomainFromUrl(url) {
    try {
        const match = new URL(url).hostname.match(/vinted\.(.+)$/);
        if (match) {
            return match[1];
        }
    } catch (error) {
        Logger.debug(`Could not read the domain of ${url}`);
    }

    return ConfigurationManager.getAlgorithmSetting.vinted_api_domain_extension;
}

/**
 * Reduces a domain extension to the key used by the shipping map ("co.uk" -> "uk").
 * @param {string} domain - Domain extension.
 * @returns {string} - Marketplace key.
 */
export function getMarketplaceKey(domain) {
    return String(domain).split('.').pop();
}

/**
 * Describes the filters of a URL in one short line, for the subscription overview.
 * @param {string} url - Vinted URL.
 * @param {string} lang - Language of the reader.
 * @returns {string} - Human readable summary.
 */
export function describeFilters(url, lang) {
    let params;
    try {
        params = new URL(url).searchParams;
    } catch (error) {
        return t(lang, 'invalid-url');
    }

    const parts = [];

    const searchText = params.get('search_text');
    if (searchText) {
        parts.push(`"${searchText}"`);
    }

    const counted = [
        ['catalog[]', 'filter-categories'],
        ['brand_ids[]', 'filter-brands'],
        ['size_ids[]', 'filter-sizes'],
        ['status_ids[]', 'filter-conditions'],
        ['color_ids[]', 'filter-colors'],
    ];

    for (const [key, translation] of counted) {
        const count = params.getAll(key).length;
        if (count > 0) {
            parts.push(t(lang, translation, { count }));
        }
    }

    const priceFrom = params.get('price_from');
    const priceTo = params.get('price_to');
    if (priceFrom || priceTo) {
        const currency = params.get('currency') || '';
        parts.push(`${priceFrom || '0'}-${priceTo || '∞'} ${currency}`.trim());
    }

    return parts.length ? parts.join(' · ') : t(lang, 'no-filters');
}
