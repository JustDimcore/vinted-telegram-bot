import { executeWithDetailedHandling, ForbiddenError, NotFoundError, RateLimitError } from "../helpers/execute_helper.js";
import RequestBuilder from "../utils/request_builder.js";
import ConfigurationManager from "../utils/config_manager.js";

const defaultExtension = ConfigurationManager.getAlgorithmSetting.vinted_api_domain_extension;

// Vinted removed /api/v2/catalog/items: it answers 404 "not_found" even with a valid session,
// while other API routes keep working with the same cookie. The website renders the catalog on
// the server instead and streams the results into the page as Next.js flight data, so the items
// are read from the catalog page itself.
const CATALOG_PAGE_TIMEOUT_MS = 30_000;
const ITEMS_MARKER = '"items":{"items":';

// Parameters describing the moment or the position of a search rather than the search itself.
// The page ignores per_page (it always renders 96 items), and order is forced below.
const VOLATILE_PARAMS = ['time', 'search_id', 'page', 'per_page', 'order'];

/**
 * Builds the catalog page URL that is fetched for a subscription.
 * @param {string} url - Vinted catalog URL saved for a subscription.
 * @param {string} domain - Domain extension of the marketplace.
 * @returns {string} - URL of the first page, newest items first.
 */
export function buildCatalogPageUrl(url, domain) {
    const source = new URL(url);
    const target = new URL(`https://www.vinted.${domain}${source.pathname}`);

    for (const [key, value] of source.searchParams) {
        if (value === '' || VOLATILE_PARAMS.includes(key)) {
            continue;
        }
        target.searchParams.append(key, value);
    }

    // Detecting new items relies on the newest ones coming first; a URL saved without an
    // order returns the results sorted by relevance.
    target.searchParams.set('order', 'newest_first');

    return target.toString();
}

/**
 * Joins the Next.js flight chunks of a page into one string.
 * Each chunk is a JSON string literal, so it is decoded with JSON.parse instead of
 * unescaping by hand.
 * @param {string} html - Page HTML.
 * @returns {string} - Decoded flight data.
 */
function decodeFlightData(html) {
    const pattern = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
    let data = '';
    let match;

    while ((match = pattern.exec(html)) !== null) {
        try {
            data += JSON.parse(`"${match[1]}"`);
        } catch (error) {
            // A chunk that is not a plain string literal carries no catalog data.
        }
    }

    return data;
}

/**
 * Cuts out the JSON array or object that starts at the given position.
 * @param {string} text - Text containing the value.
 * @param {number} start - Position of the opening bracket.
 * @returns {string|null} - The value, or null when it is not closed.
 */
function sliceBalanced(text, start) {
    const open = text[start];
    const close = open === '[' ? ']' : '}';
    let depth = 0;
    let inString = false;

    for (let i = start; i < text.length; i++) {
        const char = text[i];

        if (inString) {
            if (char === '\\') {
                i++;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
        } else if (char === open) {
            depth++;
        } else if (char === close) {
            depth--;
            if (depth === 0) {
                return text.slice(start, i + 1);
            }
        }
    }

    return null;
}

/**
 * Reads the catalog entries out of a catalog page.
 * @param {string} html - Catalog page HTML.
 * @returns {Array<Object>|null} - Raw entries, or null when the page carries no catalog data.
 */
export function readCatalogEntries(html) {
    const data = decodeFlightData(html);
    const start = data.indexOf(ITEMS_MARKER);
    if (start === -1) {
        return null;
    }

    const json = sliceBalanced(data, start + ITEMS_MARKER.length);
    if (!json) {
        return null;
    }

    try {
        return JSON.parse(json);
    } catch (error) {
        return null;
    }
}

/**
 * Flight data marks missing values with the "$undefined" placeholder.
 * @param {any} value - Raw value.
 * @returns {any} - The value, or undefined for a placeholder or an empty string.
 */
function present(value) {
    return value === '$undefined' || value === null || value === '' ? undefined : value;
}

/**
 * Converts a catalog page entry into the shape the removed API used to return,
 * so VintedItem and everything after it keep working unchanged.
 * @param {Object} entry - Raw catalog entry.
 * @param {string} domain - Domain extension of the marketplace.
 * @returns {Object} - Item in the catalog API shape.
 */
function toApiItem(entry, domain) {
    const product = entry.productItem ?? entry;
    const origin = `https://www.vinted.${domain}`;

    // The item card shows the brand on its first line and "size · condition" on the second;
    // items without a size (cosmetics, for example) carry only the condition there.
    const brand = present(product.itemBox?.firstLine);
    const secondLine = present(product.itemBox?.secondLine);
    const details = secondLine ? secondLine.split(/\s*·\s*/).filter(Boolean) : [];
    const size = details.length > 1 ? details[0] : undefined;
    const status = details.length > 0 ? details[details.length - 1] : undefined;

    const photos = (product.photos || []).map(photo => ({
        url: photo.url,
        image_no: photo.imageNo,
        dominant_color: product.dominantColor,
    }));
    if (photos.length === 0 && present(product.thumbnailUrl)) {
        photos.push({ url: product.thumbnailUrl, dominant_color: product.dominantColor });
    }

    return {
        id: Number(product.id ?? entry.id),
        title: product.title,
        url: product.url?.startsWith('http') ? product.url : `${origin}${product.url}`,
        price: { amount: product.price?.amount, currency_code: product.price?.currencyCode },
        total_item_price: { amount: product.totalItemPrice?.amount },
        brand_title: brand,
        size_title: size,
        status,
        photos,
        // The card knows only the seller id, which is enough for a link to the profile.
        user: product.user?.id
            ? { id: product.user.id, profile_url: `${origin}/member/${product.user.id}` }
            : null,
    };
}

/**
 * Fetch catalog items of a saved search from Vinted.
 * @param {Object} params - Parameters for fetching catalog items.
 * @param {string|null} params.cookie - Session cookie, or null when none could be fetched.
 * @param {string} params.url - Vinted catalog URL saved for the subscription.
 * @param {string} [params.domain] - Domain extension of the marketplace to query.
 * @returns {Promise<Object>} - Promise resolving to { items } in the catalog API shape.
 */
export async function fetchCatalogItems({ cookie, url, domain = defaultExtension }) {
    return await executeWithDetailedHandling(async () => {
        const pageUrl = buildCatalogPageUrl(url, domain);

        let request = RequestBuilder.get(pageUrl)
                        .setNextProxy()
                        .setHeaders({ 'Accept': 'text/html,application/xhtml+xml' })
                        .setTimeout(CATALOG_PAGE_TIMEOUT_MS);

        // While the marketplace refuses to hand out a session, the page is requested without one.
        if (cookie) {
            request = request.setCookie(cookie);
        }

        // Axios already throws on 4xx, so without this translation a refusal would hide
        // behind a generic 500 and the scheduler could not tell it apart from a bot error.
        let response;
        try {
            response = await request.send();
        } catch (error) {
            const status = error.response?.status;
            if (status === 429) {
                throw new RateLimitError("Rate limit exceeded.");
            }
            if (status === 403) {
                // Cloudflare in front of Vinted marks a bot challenge with this header.
                const mitigation = error.response.headers?.['cf-mitigated'];
                throw new ForbiddenError(mitigation
                    ? `Access denied by Cloudflare (${mitigation}).`
                    : "Access denied (HTTP 403).");
            }
            throw error;
        }

        if (!response.success) {
            throw new NotFoundError("Error fetching the catalog page.");
        }

        const entries = readCatalogEntries(String(response.data));
        if (!entries) {
            // Failing loudly beats silently reporting "no new items" forever after the next
            // change of the page layout.
            throw new NotFoundError("No catalog data in the catalog page, the Vinted page layout may have changed.");
        }

        return { items: entries.map(entry => toApiItem(entry, domain)) };
    });
}
