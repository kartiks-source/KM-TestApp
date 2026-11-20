'use strict';
/*
 * The store's time zone (SW-049): one helper for every store-time day, hour, month and date stamp on the server.
 * The code is public/tz.js, shared with the page (like public/roles.js), so the page and the server agree.
 * Rules: LOGIC.md §0a. Use tz.zoneOf(settings) to get the store's zone; never add a fixed +5:30 anywhere.
 */
module.exports = require('../public/tz');
