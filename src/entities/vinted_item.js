// Validation functions as standalone utilities
function validateId(value) {
  return (typeof value === 'number' && value > 0) ? value : 0;
}

function validateNumber(value) {
  return (typeof value === 'number') ? value : 0;
}

function validateString(value) {
  return (typeof value === 'string') ? value : "N/A";
}

function validateUrl(value) {
  try {
    new URL(value);
    return value;
  } catch (error) {
    return "N/A";
  }
}

class VintedPhoto {
  constructor(photo) {
    this.id = validateId(photo.id);
    this.imageNo = validateNumber(photo.image_no);
    this.width = validateNumber(photo.width);
    this.height = validateNumber(photo.height);
    this.url = validateUrl(photo.url);
    this.dominantColor = validateString(photo.dominant_color);
    // The catalog carries no full_size_url, only url and thumbnails.
    this.fullSizeUrl = validateUrl(photo.full_size_url ?? photo.url);
  }
}

class VintedUser {
  constructor(userData) {
    this.id = validateId(userData.id);
    this.login = validateString(userData.login);
    // Today's Vinted does not send the seller country in the catalog.
    this.countryCode = validateString(userData.country_code).toLowerCase();

    this.photo = userData.photo ? new VintedPhoto(userData.photo) : null;

    this.url = validateUrl(userData.profile_url);
  }
}

/**
 * An item as the catalog page shows it.
 *
 * The bot reads nothing but the catalog page, which carries no description, no seller rating
 * and no update time - so an item has none of them either.
 */
class VintedItem {
  constructor(itemData) {
    this.id = validateId(itemData.id);
    this.title = validateString(itemData.title);
    this.url = validateUrl(itemData.url);
    this.brandId = validateId(itemData.brand_id);
    this.sizeId = validateId(itemData.size_id);
    this.statusId = validateId(itemData.status_id);
    this.userId = validateId(itemData.user_id ?? itemData.user?.id);

    if (itemData.item_attributes?.length > 0 && itemData.item_attributes[0].code === "video_game_platform") {
      this.videoGamePlatformId = validateId(itemData.item_attributes[0].ids?.[0]);
    }

    this.countryId = validateId(itemData.country_id);
    this.catalogId = validateId(itemData.catalog_id);

    // Today's catalog returns size_title and brand_title instead of size and brand;
    // the old fields stay as a fallback in case the shape changes again.
    this.size = validateString(itemData.size ?? itemData.size_title);
    this.brand = validateString(itemData.brand ?? itemData.brand_title);
    this.composition = validateString(itemData.composition);
    this.status = validateString(itemData.status);
    this.label = validateString(itemData.label);
    // The price arrives as an object { amount, currency_code }, previously as two fields.
    this.currency = validateString(itemData.currency ?? itemData.price?.currency_code);
    this.priceNumeric = validateNumber(parseFloat(itemData.price_numeric ?? itemData.price?.amount));
    // Price including the buyer protection fee, when Vinted sends it.
    this.totalPriceNumeric = validateNumber(parseFloat(itemData.total_item_price?.amount));

    this.colorId = validateId(itemData.color1_id);

    // The catalog returns a photos array, some items carry a single photo in the photo field.
    const photos = itemData.photos ?? (itemData.photo ? [itemData.photo] : []);
    this.photos = photos.map(photo => new VintedPhoto(photo));

    this.user = itemData.user ? new VintedUser(itemData.user) : null;

    this.catalogBranchTitle = validateString(itemData.catalog_branch_title);
  }

  /**
   * Photo URLs in the order Vinted returns them.
   * @param {number} [limit] - Maximum number of URLs.
   * @returns {Array<string>} - Usable photo URLs.
   */
  getPhotoUrls(limit = 10) {
    return this.photos
      .map(photo => photo.fullSizeUrl)
      .filter(url => url && url !== "N/A")
      .slice(0, limit);
  }

  getDominantColor() {
    if (this.photos.length === 0) {
      return "#000000";
    }
    return this.photos[0].dominantColor;
  }
}

export { VintedItem, VintedPhoto, VintedUser };
