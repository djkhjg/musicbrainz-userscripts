// ==UserScript==
// @name         Harmony: Beatport Recovery
// @namespace    https://github.com/djkhjg/musicbrainz-userscripts
// @version      1.0.0
// @description  Recovers and caches Beatport release and optional track metadata for Harmony.
// @author       djkhjg
// @license      MIT
// @homepageURL  https://github.com/djkhjg/musicbrainz-userscripts/tree/main/harmony-beatport-recovery
// @supportURL   https://github.com/djkhjg/musicbrainz-userscripts/issues
// @downloadURL  https://raw.githubusercontent.com/djkhjg/musicbrainz-userscripts/main/harmony-beatport-recovery/harmony-beatport-recovery.user.js
// @updateURL    https://raw.githubusercontent.com/djkhjg/musicbrainz-userscripts/main/harmony-beatport-recovery/harmony-beatport-recovery.user.js
// @match        https://harmony.pulsewidth.org.uk/release*
// @match        https://harmony.mybrainz.dev/release*
// @match        https://www.beatport.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_openInTab
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(() => {
    'use strict';

    // Debug logging
    const DEBUG_FOUND_RELEASES = false;
    const DEBUG_CACHED_RELEASES = false;
    const DEBUG_CACHE_PRUNING = false;

    // Console commands for debug:
    // HBR.clearCache() -> clear entire cache
    // HBR.listCache() -> list entire cache
    // HBR.cacheStats() -> stats on current cache
    unsafeWindow.HBR = {
        clearCache: async () => {
            const confirmed =
                  unsafeWindow.confirm(
                      'Clear the entire Harmony Beatport Recovery cache?\n\n' +
                      'This cannot be undone.'
                  );

            if (!confirmed) {
                console.info(
                    '[Harmony Beatport Recovery] Cache clear cancelled'
                );

                return;
            }

            await clearEntireCache();
        },

        listCache: async () => {
            await listEntireCache();
        },

        cacheStats: async () => {
            await logCacheStats();
        },

        lru: async () => {
            console.info(
                '[Harmony Beatport Recovery] LRU',
                await loadCacheLru()
            );
        },
    };

    // constants
    const HELPER_SESSION_KEY = 'hbr-helper-session-v1';
    const CACHE_LRU_KEY = 'beatport-cache-lru';
    const CACHE_PREFIX = 'beatport-release-';
    const UPC_PREFIX = 'beatport-upc-';
    const CACHE_MAX = 2000;
    const CACHE_PRUNE_TO = 1500;
    const URL_RESOLVER_SESSION_KEY = 'hbr-url-resolver-session-v1';
    const HARMONY_CLEAR_RESOLVED_UPC_KEY = 'hbr-clear-resolved-upc-v1';
    const URL_RESULT_PREFIX = 'hbr-url-result-';
    const UNKNOWN_UPC = '[unknown]';

    const TRACK_SETTING_KEY = 'hbr-setting-track-data';
    const AUTO_SETTING_KEY = 'hbr-setting-auto';

    const LEVEL = { NONE: 0, RELEASE: 1, TRACKS: 2 };
    const MB = { download: '74', streaming: '980' };
    const NETWORK_CHANNEL = 'hbr-beatport-network-json-v1';

    const IDS = {
        button: 'hbr-beatport-search-button',
        settings: 'hbr-beatport-settings',
        trackSetting: 'hbr-setting-track-data',
        autoSetting: 'hbr-setting-auto',
        provider: 'hbr-beatport-provider-item',
        label: 'hbr-beatport-label-alt',
        trackCount: 'hbr-beatport-track-count',
        helper: 'hbr-beatport-helper-panel'
    };

    const settings = { trackData: true, auto: false };

    let passiveCacheQueue = Promise.resolve();
    const beatportAssembly = new Map();

    // runtime states
    let activeRecord = null;
    let watchedUPC = '';
    let watchedReleaseId = '';
    let harmonyUPCListener = null;
    let harmonyReleaseListener = null;
    let uiAppliedRecordStamp = '';
    let controlsReadyUPC = '';
    let activatedUPC = '';
    let harmonyRuntimeReady = false;
    let harmonyActivationPromise = null;
    let harmonyCheckScheduled = false;
    let uiApplying = false;
    let autoStartedFor = null;

    let helperSession = null;
    let helperUPCListener = null;
    let helperReleaseListener = null;
    let helperReleaseId = '';
    let harmonyUrlResolve = null;

    let urlResolverSession = null;
    let urlResolverReleaseListener = null;

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
    const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    const barcode = value => String(value ?? '').replace(/\D/g, '').replace(/^0+/, '');

    const normalizeName = value => String(value ?? '')
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const slugify = value => String(value ?? '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');

    const isHarmony = () => [
        'harmony.pulsewidth.org.uk',
        'harmony.mybrainz.dev'
    ].includes(location.hostname);

    const isBeatport = () => location.hostname === 'www.beatport.com';

    function requestId() {
        return crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function el(tag, props = {}, ...children) {
        const node = document.createElement(tag);

        for (const [key, value] of Object.entries(props)) {
            if (value == null) continue;
            if (key === 'text') node.textContent = value;
            else if (key === 'html') node.innerHTML = value;
            else if (key === 'style') Object.assign(node.style, value);
            else if (key === 'class') node.className = value;
            else if (key in node) node[key] = value;
            else node.setAttribute(key, value);
        }

        for (const child of children.flat()) {
            if (child == null) continue;
            node.append(child instanceof Node ? child : document.createTextNode(String(child)));
        }

        return node;
    }

    function beatportIcon(size = 24, stroke = 1.25) {
        return el('span', {
            class: 'beatport',
            title: 'Beatport',
            html: `<svg class="icon" width="${size}" height="${size}" stroke-width="${stroke}"><use xlink:href="/icon-sprite.svg#brand-beatport"></use></svg>`
        });
    }

    function hidden(form, name, value) {
        return form.appendChild(el('input', { type: 'hidden', name, value }));
    }

    function walkJson(value, callback, seen = new Set()) {
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        callback(value);
        for (const child of Object.values(value)) walkJson(child, callback, seen);
    }

    function jsonRoots() {
        const roots = [];

        for (const script of $$('script')) {
            const text = script.textContent?.trim();
            if (!text || (!text.startsWith('{') && !text.startsWith('['))) continue;

            try {
                roots.push(JSON.parse(text));
            } catch {
                // Not JSON.
            }
        }

        return roots;
    }

    // =========================================================================
    // Cache reads
    // =========================================================================

    const cacheKey = releaseId => `${CACHE_PREFIX}${releaseId}`;
    const upcKey = upc => `${UPC_PREFIX}${barcode(upc)}`;

    function recordLevel(record) {
        if (!record?.release) return LEVEL.NONE;

        if (
            Number(record.level) >= LEVEL.TRACKS ||
            record.release.tracklistComplete
        ) {
            return LEVEL.TRACKS;
        }

        return LEVEL.RELEASE;
    }

    async function getCachedRelease(releaseId) {
        if (releaseId == null) return null;
        return GM_getValue(cacheKey(releaseId), null);
    }

    async function readCachedUPCState(upc) {
        const wanted = barcode(upc);

        if (!wanted) {
            return {
                status: 'miss',
                releaseId: null,
                record: null
            };
        }

        const pointer =
              await GM_getValue(
                  upcKey(wanted),
                  null
              );

        if (!pointer) {
            return {
                status: 'miss',
                releaseId: null,
                record: null
            };
        }

        if (Array.isArray(pointer)) {
            return {
                status: 'ambiguous',
                releaseId: null,
                releaseIds:
                [...new Set(pointer.map(String))],
                record: null
            };
        }

        const releaseId =
              String(pointer);

        const record =
              await getCachedRelease(
                  releaseId
              );

        if (!record?.release) {
            return {
                status: 'pending',
                releaseId,
                record: null
            };
        }

        if (
            barcode(record.release.upc) !==
            wanted
        ) {
            return {
                status: 'invalid',
                releaseId,
                record: null
            };
        }

        return {
            status: 'hit',
            releaseId,
            record
        };
    }

    // debug functions
    async function clearEntireCache() {
        const keys =
              await GM_listValues();

        const cacheKeys =
              keys.filter(
                  key =>
                  key === CACHE_LRU_KEY ||
                  key.startsWith('beatport-release-') ||
                  key.startsWith('beatport-upc-')
              );

        for (const key of cacheKeys) {
            await GM_deleteValue(key);
        }

        console.info(
            '[Harmony Beatport Recovery] Cache cleared',
            {
                deleted:
                cacheKeys.length
            }
        );
    }

    async function listEntireCache() {
        const lru =
              await loadCacheLru();

        const releases = [];

        for (
            const releaseId
            of Object.keys(lru)
        ) {
            const record =
                  await getCachedRelease(
                      releaseId
                  );

            const release =
                  record?.release ||
                  null;

            const artists =
                  release?.artists
            ?.map(
                artist =>
                artist?.name ||
                artist
            )
            .filter(Boolean)
            .join(', ') ||
                  '';

            const tracks =
                  release?.tracks ||
                  [];

            releases.push({
                id:
                String(releaseId),

                artist:
                artists,

                title:
                release?.releaseName ||
                '',

                upc:
                release?.upc ||
                '',

                level:
                recordLevel(record) >=
                LEVEL.TRACKS
                ? 'TRACKS'
                : 'RELEASE',

                tracks:
                tracks.length,

                isrcs:
                tracks.filter(
                    track =>
                    clean(track?.isrc)
                ).length,

                cacheMetadata: {
                    updatedAt:
                    record?.updatedAt
                    ? new Date(
                        record.updatedAt
                    ).toISOString()
                    : null,

                    lastSeen:
                    lru[releaseId]
                    ? new Date(
                        lru[releaseId]
                    ).toISOString()
                    : null,
                },

                fullRelease:
                release
            });
        }

        releases.sort(
            (a, b) =>
            Number(a.id) -
            Number(b.id)
        );

        console.info(
            '[Harmony Beatport Recovery] Entire cache',
            releases
        );

        return releases;
    }

    // =========================================================================
    // Beatport-owned cache writes
    // =========================================================================

    async function loadCacheLru() {
        const lru = await GM_getValue(CACHE_LRU_KEY, {});

        return (
            lru &&
            typeof lru === 'object' &&
            !Array.isArray(lru)
        )
            ? lru
            : {};
    }

    const saveCacheLru = lru => GM_setValue(CACHE_LRU_KEY, lru);

    function trackListScore(tracks) {
        if (!Array.isArray(tracks)) return 0;

        return tracks.reduce(
            (score, track) =>
                score +
                (Number.isFinite(Number(track?.id)) ? 1 : 0) +
                (clean(track?.title) ? 2 : 0) +
                (
                    Array.isArray(track?.artists) &&
                    track.artists.length
                        ? 2
                        : 0
                ) +
                (clean(track?.isrc) ? 3 : 0),
            0
        );
    }

    function artistListScore(artists) {
        if (!Array.isArray(artists)) return 0;

        return artists.reduce(
            (score, artist) =>
                score +
                (artist?.id != null ? 1 : 0) +
                (clean(artist?.name) ? 1 : 0) +
                (clean(artist?.type) ? 1 : 0),
            0
        );
    }

    function hasReleaseValue(value) {
        if (value == null || value === '') return false;
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'object') return Object.keys(value).length > 0;
        return true;
    }

    function mergeRelease(existing, incoming, existingLevel, incomingLevel) {
        const existingTrackScore = trackListScore(existing?.tracks);
        const incomingTrackScore = trackListScore(incoming?.tracks);

        const preserveRicherLevel1 =
            existingLevel === LEVEL.RELEASE &&
            incomingLevel === LEVEL.RELEASE &&
            existingTrackScore > 0 &&
            incomingTrackScore === 0;

        let merged;

        if (preserveRicherLevel1) {
            merged = { ...(existing || {}) };

            for (const [key, value] of Object.entries(incoming || {})) {
                if (!hasReleaseValue(merged[key]) && hasReleaseValue(value)) {
                    merged[key] = value;
                }
            }
        } else {
            merged = {
                ...(existing || {}),
                ...(incoming || {})
            };
        }

        if (
            !barcode(incoming?.upc) &&
            barcode(existing?.upc)
        ) {
            merged.upc = existing.upc;
        }

        if (
            existingLevel === LEVEL.RELEASE &&
            incomingLevel === LEVEL.RELEASE &&
            artistListScore(existing?.artists) >
            artistListScore(incoming?.artists)
        ) {
            merged.artists = existing.artists;
        }

        if (
            existingLevel === LEVEL.RELEASE &&
            incomingLevel === LEVEL.RELEASE &&
            existingTrackScore > incomingTrackScore
        ) {
            merged.tracks = existing.tracks;
        }

        if (
            existingLevel >= LEVEL.TRACKS &&
            incomingLevel < LEVEL.TRACKS
        ) {
            merged.tracks = existing.tracks;
            merged.tracklistComplete = true;
        }

        if (incomingLevel >= LEVEL.TRACKS) {
            merged.tracks = incoming.tracks;
            merged.tracklistComplete = true;
        }

        return merged;
    }

    async function addUpcPointer(upc, releaseId) {
        const wanted = barcode(upc);
        if (!wanted) return;

        const id = String(releaseId);
        const key = upcKey(wanted);
        const current = await GM_getValue(key, null);

        if (!current) {
            await GM_setValue(key, id);
            return;
        }

        if (Array.isArray(current)) {
            const ids = [...new Set(current.map(String))];

            if (!ids.includes(id)) {
                ids.push(id);
                await GM_setValue(key, ids);
            }

            return;
        }

        if (String(current) !== id) {
            await GM_setValue(key, [String(current), id]);
        }
    }

    async function removeUpcPointer(upc, releaseId) {
        const wanted = barcode(upc);
        if (!wanted) return;

        const id = String(releaseId);
        const key = upcKey(wanted);
        const current = await GM_getValue(key, null);

        if (!current) return;

        if (Array.isArray(current)) {
            const remaining = current
                .map(String)
                .filter(value => value !== id);

            if (!remaining.length) {
                await GM_deleteValue(key);
            } else if (remaining.length === 1) {
                await GM_setValue(key, remaining[0]);
            } else {
                await GM_setValue(key, remaining);
            }

            return;
        }

        if (String(current) === id) {
            await GM_deleteValue(key);
        }
    }

    async function pruneCache(lru) {
        const entries =
              Object.entries(lru);

        if (
            entries.length <=
            CACHE_MAX
        ) {
            return lru;
        }

        entries.sort(
            (a, b) =>
            (a[1] || 0) -
            (b[1] || 0)
        );

        const removed =
              entries.slice(
                  0,
                  entries.length -
                  CACHE_PRUNE_TO
              );

        const removedReleases = [];

        for (
            const [releaseId]
            of removed
        ) {
            const record =
                  await getCachedRelease(
                      releaseId
                  );

            const upc =
                  record?.release?.upc;

            removedReleases.push({
                releaseId,

                artist:
                record?.release?.artists
                ?.map(
                    artist =>
                    artist?.name ||
                    artist
                )
                .filter(Boolean)
                .join(', ') ||
                '',

                title:
                record?.release
                ?.releaseName ||
                ''
            });

            /*
         * The release record owns the UPC relationship,
         * so read it before deleting the release.
         */
            await GM_deleteValue(
                cacheKey(
                    releaseId
                )
            );

            await removeUpcPointer(
                upc,
                releaseId
            );

            delete lru[
                releaseId
            ];
        }

        if (
            DEBUG_CACHE_PRUNING
        ) {
            console.info(
                '[Harmony Beatport Recovery] Cache pruned',
                {
                    before:
                    entries.length,

                    removed:
                    removed.length,

                    after:
                    Object.keys(
                        lru
                    ).length,

                    releases:
                    removedReleases.map(
                        release =>
                        `${release.releaseId} — ` +
                        `${release.artist || 'Unknown artist'} — ` +
                        `${release.title || 'Unknown release'}`
                    )
                }
            );
        }

        return lru;
    }

    function releaseDebugInfo(release) {
        return {
            id: release?.releaseId ?? null,
            title: release?.releaseName ?? null,
            upc: release?.upc ?? null,
            catalogNumber: release?.catalogNumber ?? null,
            label: release?.label?.name ?? null,
            trackCount: release?.trackCount ?? null
        };
    }

    async function logCacheStats() {
        const lru = await loadCacheLru();

        const entries = Object.entries(lru);

        let level1 = 0;
        let level2 = 0;
        let bytes = 0;

        for (
            const [releaseId]
            of entries
        ) {
            const record =
                  await getCachedRelease(
                      releaseId
                  );

            if (
                recordLevel(record) >=
                LEVEL.TRACKS
            ) {
                level2++;
            } else {
                level1++;
            }

            if (record) {
                bytes += new Blob([
                    JSON.stringify(
                        record
                    )
                ]).size;
            }
        }

        console.info(
            '[Harmony Beatport Recovery] Cache stats',
            {
                releases:
                entries.length,

                max:
                CACHE_MAX,

                pruneTo:
                CACHE_PRUNE_TO,

                level1,

                level2,

                sizeMB:
                (
                    bytes /
                    1024 /
                    1024
                ).toFixed(2)
            }
        );
    }

    async function cacheReleaseBatch(releases, level = LEVEL.RELEASE) {
        const valid = releases.filter(release => release?.releaseId);
        if (!valid.length) return new Map();

        let lru = await loadCacheLru();
        const saved = new Map();
        const now = Date.now();

        for (const release of valid) {
            const releaseId = String(release.releaseId);
            const existing = await getCachedRelease(releaseId);
            const existingLevel = recordLevel(existing);
            const finalLevel = Math.max(existingLevel, level);

            const mergedRelease = mergeRelease(
                existing?.release,
                release,
                existingLevel,
                level
            );

            const oldUPC = barcode(existing?.release?.upc);
            const newUPC = barcode(mergedRelease.upc);

            const changed =
                !existing ||
                existingLevel !== finalLevel ||
                JSON.stringify(existing.release) !== JSON.stringify(mergedRelease);

            let record = existing;

            if (changed) {
                record = {
                    level: finalLevel,
                    updatedAt: now,
                    release: mergedRelease
                };

                await GM_setValue(cacheKey(releaseId), record);

                if (oldUPC && oldUPC !== newUPC) {
                    await removeUpcPointer(oldUPC, releaseId);
                }

                if (newUPC) {
                    await addUpcPointer(newUPC, releaseId);
                }

                if (DEBUG_CACHED_RELEASES) {
                    const action = !existing
                        ? 'new'
                        : finalLevel > existingLevel
                            ? 'upgraded'
                            : 'updated';

                    console.info(
                        '[Harmony Beatport Recovery] Cached Beatport release',
                        {
                            action,

                            incomingLevel:
                            level,

                            existingLevel,

                            storedLevel:
                            finalLevel,

                            incoming:
                            releaseDebugInfo(
                                release
                            ),

                            stored:
                            releaseDebugInfo(
                                mergedRelease
                            )
                        }
                    );
                }
            }

            lru[releaseId] = now;

            saved.set(releaseId, record);
        }

        lru = await pruneCache(lru);
        await saveCacheLru(lru);

        return saved;
    }

    async function cacheRelease(release, level) {
        const saved = await cacheReleaseBatch([release], level);
        return saved.get(String(release?.releaseId)) || null;
    }

    // =========================================================================
    // Harmony Beatport URL -> UPC recovery
    // =========================================================================

    function beatportReleaseIdFromUrl(value) {
        try {
            const url =
                  new URL(
                      clean(value)
                  );

            if (
                ![
                    'beatport.com',
                    'www.beatport.com'
                ].includes(
                    url.hostname
                )
            ) {
                return '';
            }

            return (
                url.pathname.match(
                    /^\/release\/[^/]+\/(\d+)\/?$/
                )?.[1] ||
                ''
            );
        } catch {
            return '';
        }
    }

    function noProviderReturnedRelease() {
        return $$('.message.error')
            .some(
            message =>
            clean(
                message.textContent
            ).includes(
                'No provider returned a release'
            )
        );
    }

    function clearHarmonyUrlResolveListener() {
        if (
            harmonyUrlResolve
            ?.listener != null
        ) {
            GM_removeValueChangeListener(
                harmonyUrlResolve.listener
            );
        }

        harmonyUrlResolve = null;
    }

    function showBeatportUpcRetryStatus(upc) {
        const message =
              beatportFailureMessage();

        if (!message) {
            return;
        }

        const content =
              message.querySelector('div');

        if (!content) {
            return;
        }

        content.replaceChildren(
            el(
                'p',
                {},
                el(
                    'strong',
                    {
                        text:
                        'Beatport provider offline — '
                    }
                ),
                `retrying lookup by UPC ${clean(upc)}…`
            )
        );
    }

    function showBeatportNoUpcStatus(releaseId, releaseUrl) {
        const message =
              beatportFailureMessage();

        if (!message) {
            return;
        }

        const content =
              messageContent(
                  message
              );

        content.replaceChildren(
            el(
                'p',
                {},
                el(
                    'strong',
                    {
                        text:
                        'Beatport provider offline'
                    }
                )
            ),

            el(
                'p',
                {
                    text:
                    'Beatport Recovery found this release, but Beatport does not provide a UPC for it. Without a UPC, Harmony cannot perform the second lookup needed to construct a release for Beatport Recovery to enrich.'
                }
            ),

            el(
                'p',
                {
                    text:
                    'Seed the release directly using a Beatport MusicBrainz importer instead.'
                }
            ),

            el(
                'p',
                {},
                el(
                    'a',
                    {
                        href:
                        releaseUrl,

                        target:
                        '_blank',

                        rel:
                        'noopener noreferrer',

                        text:
                        `Open Beatport release ${releaseId}`
                    }
                )
            )
        );
    }

    function submitHarmonyWithResolvedUpc(upc) {
        const form =
              $('#url-input')
        ?.closest('form');

        const gtin =
              $('#gtin-input');

        if (
            !form ||
            !gtin ||
            !clean(upc)
        ) {
            return false;
        }

        gtin.value =
            clean(upc);

        /*
     * Notify Harmony and any other userscripts that the field changed.
     */
        gtin.dispatchEvent(
            new Event(
                'input',
                {
                    bubbles: true
                }
            )
        );

        gtin.dispatchEvent(
            new Event(
                'change',
                {
                    bubbles: true
                }
            )
        );

        console.debug(
            '[Harmony Beatport Recovery] ' +
            'Resolved Beatport URL to UPC; rerunning native Harmony lookup.',
            {
                upc:
                clean(upc)
            }
        );

    /*
     * Harmony may take a while to complete the second lookup.
     * Replace the dead-provider error with an explanation of what
     * the recovery script is doing in the meantime.
     */
        showBeatportUpcRetryStatus(
            upc
        );

        sessionStorage.setItem(
            HARMONY_CLEAR_RESOLVED_UPC_KEY,
            '1'
        );

        form.requestSubmit();

        return true;
    }

    function clearResolvedUrlUpcField() {
        if (
            sessionStorage.getItem(
                HARMONY_CLEAR_RESOLVED_UPC_KEY
            ) !== '1'
        ) {
            return;
        }

        sessionStorage.removeItem(
            HARMONY_CLEAR_RESOLVED_UPC_KEY
        );

        const gtin =
              $('#gtin-input');

        if (!gtin) {
            return;
        }

        gtin.value = '';

        gtin.dispatchEvent(
            new Event(
                'input',
                {
                    bubbles: true
                }
            )
        );

        gtin.dispatchEvent(
            new Event(
                'change',
                {
                    bubbles: true
                }
            )
        );
    }

    async function resolveFailedBeatportUrlLookup() {
        // This feature is deliberately post-failure only.
        // Until Harmony's native Beatport provider has actually failed,
        // this code does absolutely nothing.
        if (
            !beatportFailureMessage() ||
            !noProviderReturnedRelease()
        ) {
            return false;
        }

        /*
     * This is specifically for URL-only lookups.
     *
     * Once we have populated GTIN and rerun Harmony, do not attempt
     * URL resolution again even if the second lookup also fails.
     */
        const gtin =
              $('#gtin-input');

        if (
            !gtin ||
            clean(gtin.value)
        ) {
            return false;
        }

        const beatportUrl =
              clean(
                  $('#url-input')?.value
              );

        const releaseId =
              beatportReleaseIdFromUrl(
                  beatportUrl
              );

        if (!releaseId) {
            return false;
        }

        /*
     * Already resolving this failed URL.
     */
        if (harmonyUrlResolve) {
            return true;
        }

        /*
     * Fast path:
     * the exact Beatport release is already in our cache.
     */
        const cached =
              await getCachedRelease(
                  releaseId
              );

        const cachedUpc =
              clean(
                  cached
                  ?.release
                  ?.upc
              );

        if (
            cachedUpc ===
            UNKNOWN_UPC
        ) {
            showBeatportNoUpcStatus(
                releaseId,
                cached.release.releaseUrl
            );

            return true;
        }

        if (cachedUpc) {
            console.debug(
                '[Harmony Beatport Recovery] ' +
                'Failed native Beatport URL lookup resolved from cache.',
                {
                    releaseId,
                    upc:
                    cachedUpc
                }
            );

            submitHarmonyWithResolvedUpc(
                cachedUpc
            );

            return true;
        }
        /*
     * Cache miss:
     * open the exact Beatport release page.
     *
     * The universal scraper owns all parsing/cache writes.
     * Harmony only waits for that release record to acquire a UPC.
     */
        const id =
              requestId();

        const resultKey =
              `${URL_RESULT_PREFIX}${id}`;

        const state = {
            requestId:
            id,

            releaseId:
            String(
                releaseId
            ),

            listener:
            null
        };

        harmonyUrlResolve =
            state;

        await GM_deleteValue(
            resultKey
        );

        state.listener =
            GM_addValueChangeListener(
            resultKey,

            async (
                _key,
                _oldValue,
                result
            ) => {
                if (
                    harmonyUrlResolve !==
                    state ||
                    result?.requestId !==
                    id ||
                    String(
                        result?.releaseId
                    ) !==
                    String(
                        releaseId
                    ) ||
                    !clean(
                        result?.upc
                    )
                ) {
                    return;
                }

                console.debug(
                    '[Harmony Beatport Recovery] ' +
                    'Failed native Beatport URL lookup resolved by Beatport helper.',
                    result
                );

                await GM_deleteValue(
                    resultKey
                );

                clearHarmonyUrlResolveListener();

                if (
                    result.upc ===
                    UNKNOWN_UPC
                ) {
                    const record =
                          await getCachedRelease(
                              releaseId
                          );

                    showBeatportNoUpcStatus(
                        releaseId,
                        record?.release?.releaseUrl ||
                        beatportUrl
                    );

                    return;
                }

                submitHarmonyWithResolvedUpc(
                    result.upc
                );
            }
        );

        const target =
              new URL(
                  beatportUrl
              );

        target.searchParams.set(
            'hbr_resolve',
            id
        );

        target.searchParams.set(
            'hbr_release',
            String(
                releaseId
            )
        );

        console.debug(
            '[Harmony Beatport Recovery] ' +
            'Native Beatport URL lookup failed and release is not cached; ' +
            'opening exact Beatport release to discover UPC.',
            {
                releaseId,
                url:
                target.toString()
            }
        );

        openBeatport(
            target.toString()
        );

        return true;
    }

    // =========================================================================
    // Harmony release identity / settings
    // =========================================================================

    const releaseTitle = () => clean($('.release-title')?.textContent);

    function releaseArtist() {
        const container = $('.release-artist');

        return clean(
            container
            ?.querySelector('.artist-credit')
            ?.textContent ||
            container?.textContent
        );
    }

    function harmonyBarcode() {
        for (const row of $$('.release-info tr')) {
            if (
                clean($('th', row)?.textContent).toUpperCase() === 'GTIN'
            ) {
                return (
                    clean($('td', row)?.textContent)
                    .match(/\d{8,14}/)?.[0] ||
                    ''
                );
            }
        }

        return '';
    }

    const beatportEnabled = () => Boolean($('#beatport-input')?.checked);

    function searchUrl() {
        const query = [
            releaseTitle(),
            releaseArtist()
        ]
        .filter(Boolean)
        .join(' ');

        return query
            ? `https://www.beatport.com/search?q=${encodeURIComponent(query)}`
        : null;
    }

    async function loadSettings() {
        settings.trackData = await GM_getValue(TRACK_SETTING_KEY, true);
        settings.auto = await GM_getValue(AUTO_SETTING_KEY, false);
    }

    async function clearTransientState() {
        stopHarmonyCacheWatch();

        activeRecord = null;
        uiAppliedRecordStamp = '';
        controlsReadyUPC = '';
        autoStartedFor = null;
    }

    function currentRecord() {
        if (
            !activeRecord?.release ||
            !beatportEnabled()
        ) {
            return null;
        }

        return (
            barcode(activeRecord.release.upc) ===
            barcode(harmonyBarcode())
        )
            ? activeRecord
        : null;
    }

    const desiredLevel = () =>
    settings.trackData
    ? LEVEL.TRACKS
    : LEVEL.RELEASE;

    function lookupPlan() {
        const record = currentRecord();
        const have = recordLevel(record);
        const want = desiredLevel();

        if (
            record?.release &&
            have >= want
        ) {
            return {
                kind: 'open',
                targetLevel: want,
                release: record.release
            };
        }

        if (have === LEVEL.NONE) {
            return {
                kind: 'search',
                targetLevel: want
            };
        }

        if (
            have === LEVEL.RELEASE &&
            want === LEVEL.TRACKS
        ) {
            return {
                kind: 'release',
                targetLevel: LEVEL.TRACKS,
                release: record.release
            };
        }

        return null;
    }

    function setupBeatportCheckbox() {
        const checkbox = $('#beatport-input');

        if (
            !checkbox ||
            checkbox.dataset.hbrListener
        ) {
            return;
        }

        checkbox.dataset.hbrListener = '1';

        checkbox.addEventListener(
            'change',
            async () => {
                if (!checkbox.checked) {
                    await clearTransientState();
                    return;
                }

                activeRecord = null;
                uiAppliedRecordStamp = '';
                controlsReadyUPC = '';
                autoStartedFor = null;

                scheduleHarmonyCheck();
            }
        );
    }

    function beatportMessage() {
        return $$('.message').find(
            message =>
            clean($('.provider', message)?.textContent)
            .replace(/:$/, '')
            .toLowerCase() === 'beatport'
        );
    }

    const messageContent = message =>
    $('.provider', message)?.nextElementSibling ||
          message.lastElementChild ||
          message;

    function beatportFailureMessage() {
        return $$('.message.error').find(
            message => {
                const provider = clean(
                    $('.provider', message)?.textContent
                )
                .replace(/:$/, '')
                .toLowerCase();

                if (provider !== 'beatport') {
                    return false;
                }

                return clean(
                    messageContent(message)?.textContent
                ).startsWith(
                    'Failed to extract embedded JSON'
                );
            }
        );
    }

    // =========================================================================
    // Harmony settings / controls
    // =========================================================================

    function updateActionButton() {
        const button = $('#' + IDS.button);

        if (!button) {
            return;
        }

        const have =
              recordLevel(
                  currentRecord()
              );

        const want =
              desiredLevel();

        button.disabled = false;

        button.textContent =
            have === LEVEL.NONE
            ? 'Find on Beatport'
        : (
            have < want
            ? 'Retrieve track data'
            : 'Open on Beatport'
        );
    }

    function settingsPanel() {
        const track = el('input', {
            id: IDS.trackSetting,
            type: 'checkbox',
            checked: settings.trackData
        });

        const auto = el('input', {
            id: IDS.autoSetting,
            type: 'checkbox',
            checked: settings.auto
        });

        track.addEventListener(
            'change',
            async () => {
                settings.trackData = track.checked;

                await GM_setValue(
                    TRACK_SETTING_KEY,
                    settings.trackData
                );

                autoStartedFor = null;
                updateActionButton();

                if (settings.auto) {
                    maybeAutoLookup();
                }
            }
        );

        auto.addEventListener(
            'change',
            async () => {
                settings.auto = auto.checked;

                await GM_setValue(
                    AUTO_SETTING_KEY,
                    settings.auto
                );

                if (settings.auto) {
                    maybeAutoLookup();
                }
            }
        );

        return el(
            'div',
            {
                id: IDS.settings,
                style: {
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '6px 18px',
                    marginTop: '8px',
                    fontSize: '0.9em'
                }
            },
            el(
                'label',
                {
                    title:
                        'Open the exact Beatport release page and retrieve track titles, artists and ISRCs.'
                },
                track,
                ' Retrieve track data'
            ),
            el(
                'label',
                {
                    title:
                        'Automatically retrieve whatever Beatport information is still missing.'
                },
                auto,
                ' Auto'
            )
        );
    }

    function ensureSettingsPanel(parent) {
        const existing = $('#' + IDS.settings);

        if (existing) {
            const track = $('#' + IDS.trackSetting);
            const auto = $('#' + IDS.autoSetting);

            if (track) {
                track.checked = settings.trackData;
            }

            if (auto) {
                auto.checked = settings.auto;
            }

            return existing;
        }

        return parent.appendChild(settingsPanel());
    }

    function openBeatport(url) {
        try {
            if (
                typeof GM_openInTab === 'function'
            ) {
                GM_openInTab(
                    url,
                    {
                        active: true,
                        insert: true,
                        setParent: true
                    }
                );

                return;
            }
        } catch {
            // Fall through.
        }

        window.open(url, '_blank');
    }

    async function startLookup(_button = null) {
        if (!beatportEnabled()) {
            return false;
        }

        const gtin =
              barcode(
                  harmonyBarcode()
              );

        if (!gtin) {
            return false;
        }

        const plan =
              lookupPlan();

        if (!plan) {
            return false;
        }

        /*
     * Once the requested cache level is already available, this
     * is ordinary browsing rather than a recovery session.
     */
        if (plan.kind === 'open') {
            openBeatport(
                plan.release.releaseUrl
            );

            return true;
        }

        let target;

        if (plan.kind === 'release') {
            target =
                new URL(
                plan.release.releaseUrl
            );
        } else {
            const url =
                  searchUrl();

            if (!url) {
                return false;
            }

            target =
                new URL(url);
        }

        const id =
              requestId();

        target.searchParams.set(
            'hbr',
            id
        );

        target.searchParams.set(
            'hbr_upc',
            gtin
        );

        target.searchParams.set(
            'hbr_level',
            String(plan.targetLevel)
        );

        /*
     * One helper tab owns the whole recovery attempt. If it finds
     * Level 1 while Level 2 is wanted, that same tab will navigate
     * itself to the exact release page.
     */
        autoStartedFor =
            `${gtin}|${plan.targetLevel}`;

        openBeatport(
            target.toString()
        );

        return true;
    }

    function recoveryButton() {
        const button = el('button', {
            id: IDS.button,
            type: 'button',
            text: 'Find on Beatport',
            style: {
                marginTop: '8px',
                padding: '6px 12px',
                border: '1px solid #777',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '0.9em',
                fontWeight: 'bold'
            }
        });

        button.addEventListener(
            'click',
            () =>
            startLookup(
                button
            )
        );

        return button;
    }

    function ensureRecoveryControls() {
        if (!beatportEnabled()) {
            return false;
        }

        const message = beatportMessage();

        if (!message) {
            return false;
        }

        const content = messageContent(message);

        ensureSettingsPanel(content);

        if (!$('#' + IDS.button)) {
            content.appendChild(
                recoveryButton()
            );
        }

        updateActionButton();
        return true;
    }

    async function maybeAutoLookup() {
        if (
            !settings.auto ||
            !beatportEnabled() ||
            !beatportMessage()
        ) {
            return;
        }

        const plan =
              lookupPlan();

        if (
            !plan ||
            plan.kind === 'open'
        ) {
            return;
        }

        /*
     * Deliberately ignore search/release stage here.
     *
     * One helper tab is responsible for the entire request. Once
     * that helper discovers Level 1 it will navigate itself to the
     * release page when Level 2 is required.
     */
        const key =
              `${barcode(harmonyBarcode())}|${plan.targetLevel}`;

        if (
            autoStartedFor === key
        ) {
            return;
        }

        autoStartedFor = key;

        const started =
              await startLookup(
                  $('#' + IDS.button)
              );

        if (!started) {
            autoStartedFor = null;
        }
    }

    // =========================================================================
    // Harmony release UI
    // =========================================================================

    function ensureProvider(release) {
        const list = $('.provider-list');

        if (!list) return;

        let item = $('#' + IDS.provider);

        if (
            item?.dataset.releaseId ===
            String(release.releaseId)
        ) {
            return;
        }

        item ||= list.appendChild(
            el('li', {
                id: IDS.provider
            })
        );

        item.dataset.releaseId = release.releaseId;

        item.replaceChildren(
            beatportIcon(20, 1.5),
            'Beatport: ',
            el('a', {
                class: 'provider-id',
                href: release.releaseUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
                text: release.releaseId
            }),
            el('span', {
                class: 'label ml-2',
                text: 'Recovered by userscript'
            })
        );
    }

    function labelsCell({
        create = false
    } = {}) {
        const table =
              $('.release-info');

        if (!table) {
            return null;
        }

        const existing =
              $$('tr', table)
        .find(
            row =>
            clean(
                $('th', row)?.textContent
            ).toLowerCase() ===
            'labels'
        );

        if (existing) {
            return $('td', existing);
        }

        if (!create) {
            return null;
        }

        const tbody =
              $('tbody', table) ||
              table;

        const row =
              el(
                  'tr',
                  {
                      'data-hbr-beatport':
                      'labels-row'
                  },
                  el('th', {
                      text: 'Labels'
                  }),
                  el('td')
              );

        /*
     * Put the recovered label near the other release metadata.
     */
        tbody.appendChild(row);

        return $('td', row);
    }

    function ensureLabelAlternative(release) {
        if (!release.label?.name) {
            return;
        }

        const cell =
              labelsCell({
                  create: true
              });

        if (!cell) return;

        let alternatives = $(':scope > ul.alt-values', cell);

        alternatives ||= cell.appendChild(
            el('ul', {
                class: 'alt-values'
            })
        );

        let item = $('#' + IDS.label);

        const signature =
            `${release.label.id}|${release.label.name}|${release.catalogNumber}`;

        if (
            item?.dataset.signature === signature
        ) {
            return;
        }

        item ||= alternatives.appendChild(
            el('li', {
                id: IDS.label
            })
        );

        item.dataset.signature = signature;

        const labelContent = el('span', {
            class: 'entity-links'
        });

        if (release.label.id) {
            labelContent.append(
                el(
                    'a',
                    {
                        href:
                            `https://www.beatport.com/label/` +
                            `${slugify(release.label.name)}/${release.label.id}`,
                        target: '_blank',
                        rel: 'noopener noreferrer'
                    },
                    beatportIcon(18, 1.5),
                    release.label.name
                )
            );
        } else {
            labelContent.textContent = release.label.name;
        }

        item.replaceChildren(
            el(
                'ul',
                {
                    class: 'release-labels inline'
                },
                el(
                    'li',
                    {},
                    labelContent,
                    release.catalogNumber
                        ? ` ${release.catalogNumber}`
                        : ''
                )
            ),
            beatportIcon()
        );
    }

    function ensureSuccessMessage(release) {
        const message = beatportMessage();

        if (!message) return;

        const level =
            recordLevel(currentRecord()) ||
            (
                release.tracklistComplete
                    ? LEVEL.TRACKS
                    : LEVEL.RELEASE
            );

        const signature =
            `${release.releaseId}|${level}`;

        if (
            message.dataset.hbrRecovered === signature &&
            $('#' + IDS.settings) &&
            $('#' + IDS.button)
        ) {
            updateActionButton();
            return;
        }

        message.dataset.hbrRecovered = signature;

        message.classList.remove('error');
        message.style.borderColor = '#4CAF50';

        const details = el('div');

        const line = (label, value, href = null) => {
            if (
                value == null ||
                value === ''
            ) {
                return;
            }

            details.append(
                el(
                    'div',
                    {},
                    el('strong', {
                        text: `${label}: `
                    }),
                    href
                        ? el('a', {
                            href,
                            target: '_blank',
                            rel: 'noopener noreferrer',
                            text: value
                        })
                        : String(value)
                )
            );
        };

        line('Release', release.releaseName);

        line(
            'Artist',
            release.artists
                .map(artist => artist.name)
                .filter(Boolean)
                .join(', ')
        );

        line('UPC', release.upc);
        line('Catalog number', release.catalogNumber);
        line('Label', release.label?.name);

        line(
            'Beatport release',
            release.releaseId,
            release.releaseUrl
        );

        if (
            release.tracklistComplete
        ) {
            line(
                'Tracks pulled',
                release.tracks.length
            );

            line(
                'ISRCs pulled',
                release.tracks.filter(
                    track => track.isrc
                ).length
            );
        }

        const content = messageContent(message);

        content.replaceChildren(
            el(
                'p',
                {},
                el('strong', {
                    text: 'Beatport data recovered'
                })
            ),
            details
        );

        content.append(
            settingsPanel(),
            recoveryButton()
        );

        updateActionButton();
    }

    // =========================================================================
    // Harmony track comparison
    // =========================================================================

    const altList = cell =>
        $(':scope > ul.alt-values', cell) ||
        cell.appendChild(
            el('ul', {
                class: 'alt-values'
            })
        );

    function addTrackProviderIcon(cell, index, field, url) {
        const id =
              `hbr-beatport-track-${index}-${field}-provider`;

        if (
            document.getElementById(id)
        ) {
            return;
        }

        const icon =
              beatportIcon(
                  18,
                  1.5
              );

        const link =
              url
        ? el(
            'a',
            {
                id,
                href: url,
                target: '_blank',
                rel: 'noopener noreferrer'
            },
            icon
        )
        : icon;

        if (!url) {
            icon.id = id;
        }

        /*
     * Harmony puts linked provider icons inside an entity-links
     * group ahead of the displayed value.
     */
        const entityLinks =
              $(':scope > .entity-links', cell) ||
              $('.entity-links', cell);

        if (entityLinks) {
            entityLinks.prepend(
                link
            );
        } else {
            cell.prepend(
                link
            );
        }
    }

    function addTrackAlternative(cell, index, field, content, addProvider = true) {
        const id =
              `hbr-beatport-track-${index}-${field}`;

        let item =
            $('#' + id);

        item ||=
            altList(cell)
            .appendChild(
            el(
                'li',
                {
                    id
                }
            )
        );

        item.replaceChildren(
            content
        );

        if (addProvider) {
            item.append(
                beatportIcon()
            );
        }
    }

    function normalizedTrackText(value) {
    return clean(value)
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    }

    function harmonyTrackTitle(cell) {
        /*
     * Ignore Beatport alternatives that we may already have
     * inserted into this cell.
     */
        const clone =
              cell.cloneNode(true);

        $$('.alt-values', clone)
            .forEach(
            node =>
            node.remove()
        );

        $('[id^="hbr-beatport-track-"]', clone)
            ?.remove();

        return clean(
            clone.textContent
        );
    }

    function harmonyTrackArtists(cell) {
        const clone =
              cell.cloneNode(true);

        $$('.alt-values', clone)
            .forEach(
            node =>
            node.remove()
        );

        $('[id^="hbr-beatport-track-"]', clone)
            ?.remove();

        return clean(
            clone.textContent
        );
    }

    function harmonyTrackIsrc(cell) {
        const clone =
              cell.cloneNode(true);

        $$('.alt-values', clone)
            .forEach(
            node =>
            node.remove()
        );

        $('[id^="hbr-beatport-track-"]', clone)
            ?.remove();

        return clean(
            clone.textContent
        );
    }

    function beatportArtistText(track) {
        return (track.artists || [])
            .map(
            artist =>
            clean(artist.name)
        )
            .filter(Boolean)
            .join(', ');
    }

    const trackUrl = track =>
        track.id
            ? `https://www.beatport.com/track/${slugify(track.title || 'track')}/${track.id}`
            : null;

    function beatportArtistUrl(artist) {
        return artist?.id
            ? `https://www.beatport.com/artist/${slugify(
            artist.name
        )}/${artist.id}`
        : null;
    }

    function artistNode(track) {
        const wrapper =
              el(
                  'span',
                  {
                      class:
                      'artist-credit'
                  }
              );

        const artists =
              track.artists || [];

        if (!artists.length) {
            wrapper.textContent =
                '—';

            return wrapper;
        }

        artists.forEach(
            (artist, index) => {
                if (index) {
                    wrapper.append(
                        ', '
                    );
                }

                const url =
                      beatportArtistUrl(
                          artist
                      );

                const entity =
                      el(
                          'span',
                          {
                              class:
                              'entity-links'
                          }
                      );

                if (url) {
                    entity.append(
                        el(
                            'a',
                            {
                                href:
                                url,

                                target:
                                '_blank',

                                rel:
                                'noopener noreferrer'
                            },

                            beatportIcon(
                                18,
                                1.5
                            ),

                            artist.name ||
                            '—'
                        )
                    );
                } else {
                    entity.append(
                        artist.name ||
                        '—'
                    );
                }

                wrapper.append(
                    entity
                );
            }
        );

        return wrapper;
    }

    const isrcNode = isrc =>
        isrc
            ? el('code', {
                class: 'isrc',
                text: isrc
            })
            : document.createTextNode('—');

    const nativeTrackRows = table =>
        $$('tbody > tr', table)
            .filter(
                row =>
                    !row.classList.contains(
                        'hbr-beatport-extra-track'
                    )
            );

    function clearTrackComparison(table) {
        $$(
            '[id^="hbr-beatport-track-"]',
            table
        ).forEach(
            item => {
                const parent =
                      item.parentElement;

                /*
         * Remove the whitespace we inserted immediately before
         * a matching provider icon.
         */
                if (
                    item.id.endsWith(
                        '-provider'
                    ) &&
                    item.previousSibling
                    ?.nodeType ===
                    Node.TEXT_NODE &&
                    !item.previousSibling
                    .textContent.trim()
                ) {
                    item.previousSibling.remove();
                }

                item.remove();

                if (
                    parent?.classList.contains(
                        'alt-values'
                    ) &&
                    !parent.children.length
                ) {
                    parent.remove();
                }
            }
        );

        $$('.hbr-beatport-extra-track', table)
            .forEach(row => row.remove());
    }

    function trackSignature(release, harmonyCount) {
        return JSON.stringify([
            release.releaseId,
            harmonyCount,
            release.tracks.map(
                track => [
                    track.id,
                    track.title,
                    track.isrc,
                    track.artists?.map(
                        artist => [
                            artist.id,
                            artist.name
                        ]
                    )
                ]
            )
        ]);
    }

    function trackComparisonPresent(table, count) {
        const compared = Math.min(
            count,
            nativeTrackRows(table).length
        );

        for (
            let index = 0;
            index < compared;
            index++
        ) {
            const alternative =
                  document.getElementById(
                      `hbr-beatport-track-${index}-title`
                  );

            const provider =
                  document.getElementById(
                      `hbr-beatport-track-${index}-title-provider`
                  );

            if (
                !alternative &&
                !provider
            ) {
                return false;
            }
        }

        return true;
    }

    function ensureTrackCount(table, beatportCount, harmonyCount) {
        const caption = $('caption', table);

        if (!caption) return;

        let label = $('#' + IDS.trackCount);

        label ||= caption.appendChild(
            el('span', {
                id: IDS.trackCount,
                class: 'label ml-2'
            })
        );

        const matches =
            beatportCount === harmonyCount;

        label.textContent =
            matches
                ? `Beatport: ${beatportCount} tracks`
                : `Beatport: ${beatportCount} tracks — Harmony: ${harmonyCount}`;

        label.title =
            matches
                ? 'Beatport and Harmony contain the same number of tracks.'
                : 'Beatport and Harmony have different track counts.';

        label.style.backgroundColor =
            matches ? '' : '#ff9800';

        label.style.color =
            matches ? '' : '#000';
    }

    function ensureTrackComparison(release) {
        if (
            !release.tracklistComplete ||
            !Array.isArray(release.tracks)
        ) {
            return;
        }

        const table = $('table.tracklist');

        if (!table) return;

        const rows = nativeTrackRows(table);

        const signature = trackSignature(
            release,
            rows.length
        );

        if (
            table.dataset.hbrBeatportTrackSignature === signature &&
            trackComparisonPresent(
                table,
                release.tracks.length
            )
        ) {
            return;
        }

        table.dataset.hbrBeatportTrackSignature = signature;

        clearTrackComparison(table);

        ensureTrackCount(
            table,
            release.tracks.length,
            rows.length
        );

        const compareCount = Math.min(
            release.tracks.length,
            rows.length
        );

        for (
            let index = 0;
            index < compareCount;
            index++
        ) {
            const track = release.tracks[index];
            const cells = $$(':scope > td', rows[index]);

            if (cells.length < 5) {
                continue;
            }

            const url =
                  trackUrl(track);

            //
            // TITLE
            //
            const harmonyTitle =
                  harmonyTrackTitle(
                      cells[1]
                  );

            const beatportTitle =
                  clean(
                      track.title
                  );

            if (
                beatportTitle &&
                normalizedTrackText(
                    harmonyTitle
                ) ===
                normalizedTrackText(
                    beatportTitle
                )
            ) {
                addTrackProviderIcon(
                    cells[1],
                    index,
                    'title',
                    url
                );
            } else {
                addTrackAlternative(
                    cells[1],
                    index,
                    'title',
                    url
                    ? el('a', {
                        href: url,
                        target: '_blank',
                        rel: 'noopener noreferrer',
                        text:
                        track.title ||
                        '—'
                    })
                    : document.createTextNode(
                        track.title ||
                        '—'
                    )
                );
            }


            //
            // ARTISTS
            //
            const harmonyArtists =
                  harmonyTrackArtists(
                      cells[2]
                  );

            const beatportArtists =
                  beatportArtistText(
                      track
                  );

            if (
                beatportArtists &&
                normalizedTrackText(
                    harmonyArtists
                ) ===
                normalizedTrackText(
                    beatportArtists
                )
            ) {
                const artistUrl =
                      track.artists?.length === 1
                ? beatportArtistUrl(
                    track.artists[0]
                )
                : null;

                addTrackProviderIcon(
                    cells[2],
                    index,
                    'artists',
                    artistUrl
                );
            } else {
                addTrackAlternative(
                    cells[2],
                    index,
                    'artists',
                    artistNode(track),
                    false
                );
            }


            //
            // ISRC
            //
            const harmonyIsrc =
                  harmonyTrackIsrc(
                      cells[4]
                  );

            const beatportIsrc =
                  clean(
                      track.isrc
                  );

            if (
                beatportIsrc &&
                normalizedTrackText(
                    harmonyIsrc
                ) ===
                normalizedTrackText(
                    beatportIsrc
                )
            ) {
                addTrackProviderIcon(
                    cells[4],
                    index,
                    'isrc'
                );
            } else if (beatportIsrc) {
                addTrackAlternative(
                    cells[4],
                    index,
                    'isrc',
                    isrcNode(
                        track.isrc
                    )
                );
            }
        }

        if (
            release.tracks.length >
            rows.length
        ) {
            const tbody = $('tbody', table);

            for (
                let index = rows.length;
                index < release.tracks.length;
                index++
            ) {
                const track = release.tracks[index];
                const url = trackUrl(track);

                tbody.append(
                    el(
                        'tr',
                        {
                            class:
                                'hbr-beatport-extra-track',
                            title:
                                'This track exists in Beatport but has no corresponding Harmony row.'
                        },
                        el('td', {
                            class: 'numeric',
                            text: index + 1
                        }),
                        el(
                            'td',
                            {},
                            url
                                ? el('a', {
                                    href: url,
                                    target: '_blank',
                                    rel: 'noopener noreferrer',
                                    text: track.title || '—'
                                })
                                : (
                                    track.title ||
                                    '—'
                                ),
                            beatportIcon()
                        ),
                        el(
                            'td',
                            {},
                            artistNode(track),
                            beatportIcon()
                        ),
                        el('td', {
                            class: 'numeric',
                            text: '—'
                        }),
                        el(
                            'td',
                            {},
                            isrcNode(track.isrc),
                            beatportIcon()
                        )
                    )
                );
            }
        }
    }

    // =========================================================================
    // MusicBrainz seed
    // =========================================================================

    function seedLabels(form) {
        return $$(
            'input[name]',
            form
        )
            .map(
                input => {
                    const match =
                        input.name.match(
                            /^labels\.(\d+)\.name$/
                        );

                    return match
                        ? {
                            index: Number(match[1]),
                            name: input.value
                        }
                        : null;
                }
            )
            .filter(Boolean);
    }

    function ensureSeedLabelIndex(form,release) {
        const beatportLabel =
              clean(
                  release.label?.name
              );

        if (!beatportLabel) {
            return null;
        }

        const labels =
              seedLabels(form);

        /*
     * Best case: Harmony already seeded the same label.
     */
        const exact =
              labels.find(
                  label =>
                  normalizeName(
                      label.name
                  ) ===
                  normalizeName(
                      beatportLabel
                  )
              );

        if (exact) {
            return exact.index;
        }

        /*
     * Harmony omitted the Beatport label.
     *
     * Don't attach Beatport's catalog number to some unrelated
     * label. Add Beatport as a new label entry instead.
     */
        const index =
              labels.length
        ? Math.max(
            ...labels.map(
                label =>
                label.index
            )
        ) + 1
        : 0;

        const input =
              hidden(
                  form,
                  `labels.${index}.name`,
                  beatportLabel
              );

        input.dataset.hbrBeatport =
            '1';

        return index;
    }

    function ensureCatalogNumber(form, release) {
        if (
            !release.label?.name
        ) {
            return;
        }

        const index =
              ensureSeedLabelIndex(
                  form,
                  release
              );

        if (index == null) {
            return;
        }

        /*
     * The label itself is worth seeding even when Beatport has no
     * catalog number.
     */
        if (!release.catalogNumber) {
            return;
        }

        const name =
              `labels.${index}.catalog_number`;

        let input =
            $(
                `input[name="${name}"]`,
                form
            );

        if (input?.value) {
            if (
                clean(input.value) !==
                clean(
                    release.catalogNumber
                )
            ) {
                console.warn(
                    '[Harmony Beatport Recovery] Catalog number conflict:',
                    input.value,
                    release.catalogNumber
                );
            }

            return;
        }

        input ||=
            hidden(
            form,
            name,
            release.catalogNumber
        );

        input.value =
            release.catalogNumber;

        input.dataset.hbrBeatport =
            '1';
    }

    function seedUrls(form) {
        const result = new Map();

        for (
            const input
            of $$('input[name]', form)
        ) {
            const match =
                input.name.match(
                    /^urls\.(\d+)\.(url|link_type)$/
                );

            if (!match) continue;

            const index = Number(match[1]);

            result.set(
                index,
                {
                    ...result.get(index),
                    [
                        match[2] === 'url'
                            ? 'url'
                            : 'type'
                    ]: input.value
                }
            );
        }

        return result;
    }

    function ensureUrl(form, url, type) {
        const entries = seedUrls(form);

        if (
            [...entries.values()]
                .some(
                    entry =>
                        clean(entry.url) === clean(url) &&
                        String(entry.type) === String(type)
                )
        ) {
            return;
        }

        const index =
            entries.size
                ? Math.max(...entries.keys()) + 1
                : 0;

        hidden(
            form,
            `urls.${index}.url`,
            url
        ).dataset.hbrBeatport = '1';

        hidden(
            form,
            `urls.${index}.link_type`,
            type
        ).dataset.hbrBeatport = '1';
    }

    function ensureEditNote(form, release) {
        const field = $('[name="edit_note"]', form);

        if (!field) return;

        const line =
            `* Beatport: ${release.releaseUrl}`;

        if (
            !field.value.includes(line)
        ) {
            field.value +=
                `${
                    field.value &&
                    !field.value.endsWith('\n')
                        ? '\n'
                        : ''
                }${line}`;
        }
    }

    function patchSeed(form, release) {
        if (
            !beatportEnabled() ||
            !release
        ) {
            return;
        }

        const name =
            form.getAttribute('name');

        if (
            ![
                'release-seeder',
                'release-update-seeder'
            ].includes(name)
        ) {
            return;
        }

        ensureUrl(
            form,
            release.releaseUrl,
            MB.download
        );

        ensureUrl(
            form,
            release.releaseUrl,
            MB.streaming
        );

        ensureEditNote(
            form,
            release
        );

        if (
            name === 'release-seeder'
        ) {
            ensureCatalogNumber(
                form,
                release
            );
        }
    }

    function patchSeeds(release) {
        $$(
            'form[name="release-seeder"], form[name="release-update-seeder"]'
        ).forEach(
            form =>
                patchSeed(
                    form,
                    release
                )
        );
    }

    function setupSubmitProtection() {
        document.addEventListener(
            'submit',
            event => {
                const record = currentRecord();

                if (
                    !record?.release ||
                    !(
                        event.target instanceof
                        HTMLFormElement
                    )
                ) {
                    return;
                }

                patchSeed(
                    event.target,
                    record.release
                );
            },
            true
        );
    }

    // =========================================================================
    // Harmony cache monitoring
    // =========================================================================

    function removeGMListener(listenerId) {
        if (listenerId == null) {
            return;
        }

        try {
            GM_removeValueChangeListener(
                listenerId
            );
        } catch {
            // Listener may already be gone.
        }
    }

    function clearHarmonyReleaseWatch() {
        removeGMListener(
            harmonyReleaseListener
        );

        harmonyReleaseListener = null;
        watchedReleaseId = '';
    }

    function stopHarmonyCacheWatch() {
        removeGMListener(
            harmonyUPCListener
        );

        harmonyUPCListener = null;
        watchedUPC = '';

        clearHarmonyReleaseWatch();
    }

    function applyHarmonyCachedRecord(wantedUPC, releaseId, record) {
        if (
            watchedUPC !== wantedUPC ||
            watchedReleaseId !== String(releaseId)
        ) {
            return;
        }

        const valid =
              record?.release &&
              barcode(record.release.upc) ===
              wantedUPC;

        activeRecord =
            valid
            ? record
        : null;

        uiAppliedRecordStamp = '';
        controlsReadyUPC = '';

        scheduleHarmonyCheck();
    }

    async function watchHarmonyRelease(wantedUPC, releaseId) {
        const id =
              String(releaseId);

        if (
            watchedReleaseId !== id
        ) {
            clearHarmonyReleaseWatch();

            watchedReleaseId = id;

            harmonyReleaseListener =
                GM_addValueChangeListener(
                cacheKey(id),
                (
                    _key,
                    _oldValue,
                    newValue
                ) =>
                applyHarmonyCachedRecord(
                    wantedUPC,
                    id,
                    newValue
                )
            );
        }

        const record =
              await getCachedRelease(id);

        if (
            watchedUPC !== wantedUPC ||
            watchedReleaseId !== id
        ) {
            return;
        }

        const valid =
              record?.release &&
              barcode(record.release.upc) ===
              wantedUPC;

        activeRecord =
            valid
            ? record
        : null;

        uiAppliedRecordStamp = '';
        controlsReadyUPC = '';
    }

    async function refreshHarmonyUPCWatch(wantedUPC) {
        if (
            watchedUPC !== wantedUPC
        ) {
            return;
        }

        const state =
              await readCachedUPCState(
                  wantedUPC
              );

        if (
            watchedUPC !== wantedUPC
        ) {
            return;
        }

        if (
            !state.releaseId ||
            state.status === 'ambiguous'
        ) {
            clearHarmonyReleaseWatch();

            activeRecord = null;
            uiAppliedRecordStamp = '';
            controlsReadyUPC = '';

            scheduleHarmonyCheck();
            return;
        }

        await watchHarmonyRelease(
            wantedUPC,
            state.releaseId
        );

        scheduleHarmonyCheck();
    }

    async function ensureHarmonyCacheWatch(upc) {
        const wanted =
              barcode(upc);

        if (!wanted) {
            stopHarmonyCacheWatch();
            return;
        }

        if (
            watchedUPC === wanted &&
            harmonyUPCListener != null
        ) {
            return;
        }

        stopHarmonyCacheWatch();

        watchedUPC = wanted;

        harmonyUPCListener =
            GM_addValueChangeListener(
            upcKey(wanted),
            () =>
            refreshHarmonyUPCWatch(
                wanted
            ).catch(
                error =>
                console.warn(
                    '[Harmony Beatport Recovery] Could not refresh watched Beatport UPC.',
                    error
                )
            )
        );

        await refreshHarmonyUPCWatch(
            wanted
        );
    }

    async function activateHarmony(upc) {
        if (
            activatedUPC === upc &&
            harmonyRuntimeReady
        ) {
            return;
        }

        if (harmonyActivationPromise) {
            await harmonyActivationPromise;

            if (
                activatedUPC === upc
            ) {
                return;
            }
        }

        harmonyActivationPromise =
            (async () => {
            stopHarmonyCacheWatch();

            activatedUPC = upc;
            activeRecord = null;
            uiAppliedRecordStamp = '';
            controlsReadyUPC = '';
            autoStartedFor = null;

            if (!harmonyRuntimeReady) {
                await loadSettings();
                setupSubmitProtection();

                harmonyRuntimeReady = true;
            }

            setupBeatportCheckbox();

            console.debug(
                `[Harmony Beatport Recovery] Activated after native Beatport failure for UPC ${upc}.`
            );
        })();

        try {
            await harmonyActivationPromise;
        } finally {
            harmonyActivationPromise = null;
        }
    }

    function syncRecoveredUi(release) {
        if (uiApplying) {
            return;
        }

        uiApplying = true;

        try {
            ensureSuccessMessage(
                release
            );

            ensureProvider(
                release
            );

            ensureLabelAlternative(
                release
            );

            ensureTrackComparison(
                release
            );

            patchSeeds(
                release
            );
        } finally {
            uiApplying = false;
        }
    }

    function harmonyUiReady(record) {
        if (
            !beatportMessage() ||
            !$('.provider-list')
        ) {
            return false;
        }

        if (
            recordLevel(record) >= LEVEL.TRACKS &&
            !$('table.tracklist')
        ) {
            return false;
        }

        return true;
    }

    function harmonyRecordStamp(record) {
        if (!record?.release) {
            return '';
        }

        return [
            record.release.releaseId,
            recordLevel(record),
            record.updatedAt || 0
        ].join('|');
    }

    async function checkHarmonyState() {
        const upc =
              barcode(
                  harmonyBarcode()
              );

        const enteredUpc =
              barcode(
                  $('#gtin-input')?.value
              );

        /*
     * Harmony has completely failed to construct a release.
     *
     * A GTIN in the search box does NOT by itself imply that this
     * lookup has anything to do with Beatport.
     *
     * Only show our Beatport-specific explanation if that GTIN is
     * already known in the Beatport cache.
     */
        if (
            beatportFailureMessage() &&
            noProviderReturnedRelease() &&
            enteredUpc &&
            !upc
        ) {
            await showNoHarmonyReleaseMessage(
                enteredUpc
            );

            return;
        }

        /*
     * A failed Beatport URL-only lookup has no rendered Harmony UPC yet.
     *
     * Only after Harmony itself has:
     *
     *   - failed Beatport with "Failed to extract embedded JSON"
     *   - returned no release
     *   - preserved a Beatport release URL
     *   - left GTIN empty
     *
     * do we attempt URL -> UPC recovery.
     */
        if (!upc) {
            await resolveFailedBeatportUrlLookup();

            return;
        }

        /*
     * Preserve the strict activation rule:
     *
     * - Harmony must have rendered a UPC
     * - its native Beatport provider must have failed with the
     *   expected "Failed to extract embedded JSON" error
     */
        if (
            activatedUPC !== upc
        ) {
            if (!beatportFailureMessage()) {
                return;
            }

            await activateHarmony(
                upc
            );
        }

        if (
            activatedUPC !== upc ||
            !harmonyRuntimeReady
        ) {
            return;
        }

        setupBeatportCheckbox();

        if (!beatportEnabled()) {
            return;
        }

        /*
     * From this point onward Harmony never performs another
     * Beatport lookup. It simply watches the UPC pointer and,
     * once known, that release's cache record.
     */
        await ensureHarmonyCacheWatch(
            upc
        );

        if (activeRecord?.release) {
            const stamp =
                  harmonyRecordStamp(
                      activeRecord
                  );

            if (
                uiAppliedRecordStamp !== stamp &&
                harmonyUiReady(activeRecord)
            ) {
                syncRecoveredUi(
                    activeRecord.release
                );

                uiAppliedRecordStamp =
                    stamp;
            }

            if (beatportMessage()) {
                await maybeAutoLookup();
            }

            return;
        }

        if (beatportMessage()) {
            if (
                controlsReadyUPC !== upc &&
                ensureRecoveryControls()
            ) {
                controlsReadyUPC = upc;
            }

            await maybeAutoLookup();
        }
    }

    async function showNoHarmonyReleaseMessage(upc) {
        const wantedUpc =
              barcode(
                  upc
              );

        if (!wantedUpc) {
            return false;
        }

        /*
     * A bare GTIN lookup is only considered a Beatport case if
     * our cache already associates that UPC with a Beatport release.
     *
     * Otherwise there is no reason to assume the user's lookup
     * has anything to do with Beatport, so leave Harmony's native
     * error message completely untouched.
     */
        const state =
              await readCachedUPCState(
                  wantedUpc
              );

        if (
            state.status !== 'hit' ||
            !state.record?.release
        ) {
            return false;
        }

        const release =
              state.record.release;

        const message =
              beatportFailureMessage();

        if (!message) {
            return false;
        }

        if (
            message.dataset
            .hbrNoHarmonyRelease ===
            String(release.releaseId)
        ) {
            return true;
        }

        message.dataset
            .hbrNoHarmonyRelease =
            String(
            release.releaseId
        );

        const content =
              messageContent(
                  message
              );

        content.replaceChildren(
            el(
                'p',
                {},
                el(
                    'strong',
                    {
                        text:
                        'Beatport provider offline'
                    }
                )
            ),

            el(
                'p',
                {
                    text:
                    'No other Harmony provider returned a release for this GTIN, so Beatport Recovery cannot build a Harmony release to enrich.'
                }
            ),

            el(
                'p',
                {
                    text:
                    'This GTIN matches a Beatport release already found in the Beatport Recovery cache. Seed the release directly using a Beatport MusicBrainz importer instead.'
                }
            ),

            el(
                'p',
                {},
                el(
                    'a',
                    {
                        href:
                        release.releaseUrl,

                        target:
                        '_blank',

                        rel:
                        'noopener noreferrer',

                        text:
                        'Open release on Beatport'
                    }
                )
            )
        );

        return true;
    }

    function scheduleHarmonyCheck() {
        if (
            uiApplying ||
            harmonyCheckScheduled
        ) {
            return;
        }

        harmonyCheckScheduled = true;

        requestAnimationFrame(
            () => {
                harmonyCheckScheduled = false;

                checkHarmonyState()
                    .catch(
                    error =>
                    console.warn(
                        '[Harmony Beatport Recovery] Harmony state check failed.',
                        error
                    )
                );
            }
        );
    }

    function initHarmony() {
        clearResolvedUrlUpcField();

        new MutationObserver(
            scheduleHarmonyCheck
        ).observe(
            document.body,
            {
                childList: true,
                subtree: true
            }
        );

        scheduleHarmonyCheck();
    }

    // =========================================================================
    // Beatport release intake
    // =========================================================================

    const hasOwn = (object, key) =>
        Object.prototype.hasOwnProperty.call(
            object,
            key
        );

    function beatportReleaseUrl(releaseId, releaseName, releaseSlug = '') {
        const slug =
            clean(releaseSlug) ||
            slugify(
                releaseName ||
                'release'
            );

        return (
            `https://www.beatport.com/release/` +
            `${slug}/${releaseId}`
        );
    }

    function beatportReleaseShape(value) {
        if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value)
        ) {
            return null;
        }

        const legacyId =
            Number(value.release_id);

        if (
            Number.isInteger(legacyId) &&
            legacyId > 0 &&
            clean(value.release_name) &&
            hasOwn(value, 'catalog_number') &&
            hasOwn(value, 'track_count') &&
            value.label &&
            typeof value.label === 'object' &&
            Array.isArray(value.artists)
        ) {
            return 'legacy';
        }

        const v4Id =
            Number(value.id);

        if (
            Number.isInteger(v4Id) &&
            v4Id > 0 &&
            clean(value.name) &&
            hasOwn(value, 'catalog_number') &&
            hasOwn(value, 'track_count') &&
            value.label &&
            typeof value.label === 'object' &&
            Array.isArray(value.artists)
        ) {
            return 'v4';
        }

        return null;
    }

    // release objects found on Search page
    function normalizeLegacyRelease(release) {
        return {
            releaseId: release.release_id,
            releaseName: release.release_name,
            upc: barcode(release.upc) || UNKNOWN_UPC,
            catalogNumber: release.catalog_number,

            label:
                release.label
                    ? {
                        id:
                            release.label.label_id ??
                            null,
                        name:
                            release.label.label_name ??
                            null
                    }
                    : null,

            artists:
                (release.artists || [])
                    .map(
                        artist => ({
                            id:
                                artist.artist_id ??
                                null,
                            name:
                                artist.artist_name ??
                                null,
                            type:
                                artist.artist_type_name ??
                                null
                        })
                    ),

            aggregator:
                release.aggregator
                    ? {
                        id:
                            release.aggregator.aggregator_id ??
                            null,
                        name:
                            release.aggregator.aggregator_name ??
                            null
                    }
                    : null,

            genres:
                (release.genre || [])
                    .map(
                        genre => ({
                            id:
                                genre.genre_id ??
                                null,
                            name:
                                genre.genre_name ??
                                null
                        })
                    ),

            tracks:
                (release.tracks || [])
                    .map(
                        (track, index) => ({
                            id:
                                Number(
                                    track.track_id ??
                                    track.id
                                ),
                            number:
                                index + 1,
                            title:
                                track.track_name ??
                                track.name ??
                                null
                        })
                    )
                    .filter(
                        track =>
                            Number.isFinite(
                                track.id
                            )
                    ),

            releaseDate: release.release_date ?? null,
            publishDate: release.publish_date ?? null,
            preorderDate: release.pre_order_date ?? null,
            exclusiveDate: release.exclusive_date ?? null,
            trackCount: release.track_count ?? null,
            availableWorldwide: release.available_worldwide ?? null,
            image: release.release_image_uri ?? null,
            price: release.price ?? null,

            releaseUrl:
                beatportReleaseUrl(
                    release.release_id,
                    release.release_name
                ),

            tracklistComplete:
                false
        };
    }

    //release objects found on Artist page, recommendeds, and the full release page itself
    function normalizeV4Release(release) {
        const trackUrls =
              Array.isArray(release.tracks)
        ? release.tracks.filter(
            value =>
            typeof value === 'string' &&
            value.includes('/catalog/tracks/')
        )
        : [];

        return {
            releaseId: release.id,
            releaseName: release.name,
            upc: barcode(release.upc) || UNKNOWN_UPC,
            catalogNumber: release.catalog_number,

            label: release.label
            ? {
                id: release.label.id ?? null,
                name: release.label.name ?? null
            }
            : null,

            artists: (release.artists || []).map(artist => ({
                id: artist.id ?? null,
                name: artist.name ?? null
            })),

            /*
         * Only full/rich v4 release objects normally contain this.
         * Keep Beatport's raw order here. It is reversed later when
         * assembling Level 2.
         */
            ...(trackUrls.length
                ? { trackUrls }
                : {}),

            releaseDate:
            release.new_release_date ??
            release.publish_date ??
            null,

            publishDate:
            release.publish_date ??
            null,

            preorderDate:
            release.pre_order_date ??
            null,

            trackCount:
            release.track_count ??
            null,

            image:
            release.image?.uri ??
            null,

            price:
            release.price ??
            null,

            releaseUrl:
            beatportReleaseUrl(
                release.id,
                release.name,
                release.slug
            ),

            tracklistComplete:
            false
        };
    }

    function normalizeBeatportRelease(release) {
        const shape =
            beatportReleaseShape(release);

        if (
            shape === 'legacy'
        ) {
            return normalizeLegacyRelease(
                release
            );
        }

        if (
            shape === 'v4'
        ) {
            return normalizeV4Release(
                release
            );
        }

        return null;
    }

    // Universal Beatport payload intake
    //
    // Every Beatport JSON payload can contribute one or more pieces:
    //
    //   release entity
    //       -> Level 1 metadata
    //       -> possibly reversed release.trackUrls
    //
    //   rich track query
    //       -> titles / artists / ISRCs / track URLs
    //
    // Pieces are assembled by Beatport release ID. Once both halves exist,
    // the release is upgraded to Level 2.
    function normalizeBeatportTracks(rawTracks) {
        return (rawTracks || [])
            .map(track => ({
            id:
            Number(
                track?.id ??
                track?.track_id
            ),

            url:
            clean(track?.url) ||
            null,

            title:
            track?.name ??
            track?.track_name ??
            null,

            artists:
            trackArtists(track),

            isrc:
            clean(track?.isrc) ||
            null,

            mixName:
            track?.mix_name ??
            null,

            lengthMs:
            Number.isFinite(
                Number(track?.length_ms)
            )
            ? Number(track.length_ms)
            : null
        }))
            .filter(
            track =>
            Number.isFinite(track.id)
        );
    }

    function mergeNormalizedTracks(existing = [], incoming = []) {
        const tracks = new Map();

        for (
            const track
            of [...existing, ...incoming]
        ) {
            if (!Number.isFinite(Number(track?.id))) {
                continue;
            }

            tracks.set(
                Number(track.id),
                track
            );
        }

        return [...tracks.values()];
    }

    function mergeObservedRelease(existing, incoming) {
        if (!existing) {
            return incoming;
        }

        const merged =
              mergeRelease(
                  existing,
                  incoming,
                  LEVEL.RELEASE,
                  LEVEL.RELEASE
              );

        /*
     * Never let a sparse release observation erase a richer
     * full-release track URL list.
     */
        if (
            (existing.trackUrls?.length || 0) >
            (incoming.trackUrls?.length || 0)
        ) {
            merged.trackUrls =
                existing.trackUrls;
        }

        return merged;
    }

    // Embedded React Query representation:
    //
    // queryKey:
    //   ["tracks", { release_id: 123, ... }]
    //
    // state.data.results:
    //   [rich track objects]
    function beatportTracklistQuery(value) {
        if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            !Array.isArray(value.queryKey)
        ) {
            return null;
        }

        if (
            value.queryKey[0] !== 'tracks'
        ) {
            return null;
        }

        const params =
              value.queryKey[1];

        const releaseId =
              Number(
                  params?.release_id
              );

        const results =
              value.state?.data?.results;

        if (
            !Number.isInteger(releaseId) ||
            releaseId <= 0 ||
            !Array.isArray(results) ||
            !results.length
        ) {
            return null;
        }

        const tracks =
              normalizeBeatportTracks(
                  results
              );

        if (!tracks.length) {
            return null;
        }

        return {
            releaseId,
            tracks
        };
    }

    // Direct API response representation.
    // The network interceptor sees the raw tracks endpoint response,
    // which does NOT have a React Query queryKey wrapper. In that case
    // the release ID comes from the request URL.
    function beatportTracklistResponse(payload, sourceUrl = '') {
        if (
            !payload ||
            typeof payload !== 'object' ||
            Array.isArray(payload) ||
            !Array.isArray(payload.results) ||
            !payload.results.length
        ) {
            return null;
        }

        let url;

        try {
            url =
                new URL(
                sourceUrl,
                location.href
            );
        } catch {
            return null;
        }

        if (
            !url.pathname.includes(
                '/catalog/tracks'
            )
        ) {
            return null;
        }

        const releaseId =
              Number(
                  url.searchParams.get(
                      'release_id'
                  )
              );

        if (
            !Number.isInteger(releaseId) ||
            releaseId <= 0
        ) {
            return null;
        }

        const tracks =
              normalizeBeatportTracks(
                  payload.results
              );

        if (!tracks.length) {
            return null;
        }

        return {
            releaseId,
            tracks
        };
    }

    function inspectBeatportPayload(payload, sourceUrl = '') {
        const releases =
              new Map();

        const tracklists =
              new Map();

        const rememberRelease =
              release => {
                  const key =
                        String(
                            release.releaseId
                        );

                  releases.set(
                      key,
                      mergeObservedRelease(
                          releases.get(key),
                          release
                      )
                  );
              };

        const rememberTracklist =
              tracklist => {
                  if (!tracklist) {
                      return;
                  }

                  const key =
                        String(
                            tracklist.releaseId
                        );

                  const existing =
                        tracklists.get(key);

                  tracklists.set(
                      key,
                      {
                          releaseId:
                          tracklist.releaseId,

                          tracks:
                          mergeNormalizedTracks(
                              existing?.tracks,
                              tracklist.tracks
                          )
                      }
                  );
              };

        walkJson(
            payload,
            value => {
                if (
                    !value ||
                    typeof value !== 'object' ||
                    Array.isArray(value)
                ) {
                    return;
                }

                /*
             * Existing Level-1 release recognition.
             */
                const release =
                      normalizeBeatportRelease(
                          value
                      );

                if (release?.releaseId) {
                    rememberRelease(
                        release
                    );
                }

                /*
             * Embedded rich track query recognition.
             */
                const tracklist =
                      beatportTracklistQuery(
                          value
                      );

                if (tracklist) {
                    rememberTracklist(
                        tracklist
                    );
                }
            }
        );

        /*
     * Network responses from /catalog/tracks do not contain the
     * React Query wrapper, so recognize those using their URL.
     */
        rememberTracklist(
            beatportTracklistResponse(
                payload,
                sourceUrl
            )
        );

        return {
            releases:
            [...releases.values()],

            tracklists:
            [...tracklists.values()]
        };
    }

    function assemblyForRelease(releaseId) {
        const key =
              String(releaseId);

        let assembly =
            beatportAssembly.get(key);

        if (!assembly) {
            assembly = {
                release:
                null,

                richTracks:
                [],

                level2Complete:
                false
            };

            beatportAssembly.set(
                key,
                assembly
            );
        }

        return assembly;
    }

    function beatportTrackIdFromUrl(url) {
        const match =
              String(url || '')
        .match(
            /\/tracks\/(\d+)\/?(?:\?.*)?$/
        );

        if (!match) {
            return null;
        }

        const id =
              Number(match[1]);

        return Number.isFinite(id)
            ? id
        : null;
    }

    // Beatport's release.tracks URL array is stored in reverse release
    // order. Reverse it, then use those URLs to arrange the rich track objects.
    function buildLevel2Release(release, richTracks) {
        if (
            !release?.releaseId ||
            !Array.isArray(release.trackUrls) ||
            !release.trackUrls.length ||
            !Array.isArray(richTracks) ||
            !richTracks.length
        ) {
            return null;
        }

        const expectedCount =
              Number(
                  release.trackCount
              );

        if (
            Number.isFinite(expectedCount) &&
            expectedCount > 0
        ) {
            if (
                release.trackUrls.length !==
                expectedCount
            ) {
                return null;
            }

            /*
         * Rich tracks may arrive over more than one paginated
         * response, so only reject if we have too few.
         */
            if (
                richTracks.length <
                expectedCount
            ) {
                return null;
            }
        }

        const orderedUrls =
              release.trackUrls
        .slice()
        .reverse();

        const tracksByUrl =
              new Map();

        const tracksById =
              new Map();

        for (
            const track
            of richTracks
        ) {
            if (track.url) {
                tracksByUrl.set(
                    track.url,
                    track
                );
            }

            if (
                Number.isFinite(
                    Number(track.id)
                )
            ) {
                tracksById.set(
                    Number(track.id),
                    track
                );
            }
        }

        const tracks = [];

        for (
            let index = 0;
            index < orderedUrls.length;
            index++
        ) {
            const url =
                  orderedUrls[index];

            /*
         * Exact URL matching is Harmony's original strategy.
         * ID matching is a harmless fallback in case Beatport
         * changes API hostnames while keeping the same track IDs.
         */
            const orderedId =
                  beatportTrackIdFromUrl(
                      url
                  );

            const track =
                  tracksByUrl.get(url) ||
                  (
                      orderedId != null
                      ? tracksById.get(
                          orderedId
                      )
                      : null
                  );

            if (!track) {
                return null;
            }

            tracks.push({
                ...track,
                number:
                index + 1,
                metadataFound:
                true
            });
        }

        if (
            Number.isFinite(expectedCount) &&
            expectedCount > 0 &&
            tracks.length !== expectedCount
        ) {
            return null;
        }

        return {
            ...release,
            tracks,
            tracklistComplete:
            true
        };
    }

    async function tryAssembleLevel2(releaseId) {
        const assembly =
              assemblyForRelease(
                  releaseId
              );

        if (
            assembly.level2Complete
        ) {
            return null;
        }

        /*
     * The persistent cache is authoritative.
     *
     * If this release is already Level 2, there is nothing
     * for the assembler to rebuild. Any Level-1 metadata
     * observed immediately beforehand has already been merged
     * into that Level-2 cache record by cacheReleaseBatch().
     */
        const cached =
              await getCachedRelease(
                  releaseId
              );

        if (
            cached &&
            recordLevel(cached) >=
            LEVEL.TRACKS
        ) {
            assembly.level2Complete =
                true;

            /*
         * Keep the in-memory assembly synchronized with the
         * canonical cached release in case anything else in
         * this page session refers to it.
         */
            assembly.release =
                cached.release;

            return cached;
        }

        /*
     * If the track query arrived before the release object,
     * a cached Level-1 record can supply the release half.
     */
        if (
            !assembly.release &&
            cached?.release
        ) {
            assembly.release =
                cached.release;
        }

        if (
            !assembly.release ||
            !assembly.richTracks.length
        ) {
            return null;
        }

        const level2 =
              buildLevel2Release(
                  assembly.release,
                  assembly.richTracks
              );

        if (!level2) {
            return null;
        }

        const record =
              await cacheRelease(
                  level2,
                  LEVEL.TRACKS
              );

        if (record) {
            assembly.level2Complete =
                true;
        }

        return record;
    }

    async function ingestBeatportDataNow(data, sourceUrl = '', source = 'network') {
        /*
     * A single payload can contain the same release more than once.
     * Deduplicate/merge it before touching storage.
     */
        const releases =
              new Map();

        for (
            const release
            of data.releases || []
        ) {
            if (!release?.releaseId) {
                continue;
            }

            const key =
                  String(
                      release.releaseId
                  );

            releases.set(
                key,
                mergeObservedRelease(
                    releases.get(key),
                    release
                )
            );
        }

        const tracklists =
              new Map();

        for (
            const tracklist
            of data.tracklists || []
        ) {
            if (!tracklist?.releaseId) {
                continue;
            }

            const key =
                  String(
                      tracklist.releaseId
                  );

            const existing =
                  tracklists.get(key);

            tracklists.set(
                key,
                {
                    releaseId:
                    tracklist.releaseId,

                    tracks:
                    mergeNormalizedTracks(
                        existing?.tracks,
                        tracklist.tracks
                    )
                }
            );
        }

        const touchedReleaseIds =
              new Set();

        /*
     * First feed all discovered pieces into the in-memory assembler.
     */
        for (
            const release
            of releases.values()
        ) {
            const assembly =
                  assemblyForRelease(
                      release.releaseId
                  );

            assembly.release =
                mergeObservedRelease(
                assembly.release,
                release
            );

            touchedReleaseIds.add(
                String(
                    release.releaseId
                )
            );

            if (
                DEBUG_FOUND_RELEASES
            ) {
                console.info(
                    '[Harmony Beatport Recovery] Found Beatport release',
                    {
                        source,
                        url:
                        sourceUrl,
                        ...releaseDebugInfo(
                            release
                        )
                    }
                );
            }
        }

        for (
            const tracklist
            of tracklists.values()
        ) {
            const assembly =
                  assemblyForRelease(
                      tracklist.releaseId
                  );

            assembly.richTracks =
                mergeNormalizedTracks(
                assembly.richTracks,
                tracklist.tracks
            );

            touchedReleaseIds.add(
                String(
                    tracklist.releaseId
                )
            );
        }

        /*
     * Every recognized release still enters the normal Level-1
     * cache exactly as before.
     */
        if (releases.size) {
            await cacheReleaseBatch(
                [...releases.values()],
                LEVEL.RELEASE
            );
        }

        /*
     * Any touched release may now have both halves required
     * for Level 2.
     */
        for (
            const releaseId
            of touchedReleaseIds
        ) {
            await tryAssembleLevel2(
                releaseId
            );
        }
    }

    // =========================================================================
    // Beatport network interception
    // =========================================================================

    function installBeatportNetworkInterceptor() {
        if (!isBeatport()) {
            return;
        }

        const page =
              typeof unsafeWindow !== 'undefined'
        ? unsafeWindow
        : window;

        if (
            page.__hbrNetworkInterceptorInstalled
        ) {
            return;
        }

        page.__hbrNetworkInterceptorInstalled = true;

        function publish(
        url,
         payload
        ) {
            try {
                page.postMessage(
                    {
                        channel:
                        NETWORK_CHANNEL,
                        url:
                        String(url || ''),
                        payload
                    },
                    page.location.origin
                );
            } catch {
                // Never interfere with Beatport.
            }
        }

        if (
            typeof page.fetch === 'function'
        ) {
            const originalFetch =
                  page.fetch;

            page.fetch =
                function (...args) {
                const promise =
                      originalFetch.apply(
                          this,
                          args
                      );

                promise
                    .then(
                    response => {
                        try {
                            if (
                                !response?.ok
                            ) {
                                return;
                            }

                            const type =
                                  response.headers
                            ?.get('content-type') ||
                                  '';

                            if (
                                !type
                                .toLowerCase()
                                .includes('json')
                            ) {
                                return;
                            }

                            response
                                .clone()
                                .json()
                                .then(
                                payload =>
                                publish(
                                    response.url,
                                    payload
                                )
                            )
                                .catch(
                                () => {}
                            );
                        } catch {
                            // Never interfere with Beatport.
                        }
                    }
                )
                    .catch(
                    () => {}
                );

                return promise;
            };
        }

        const XHR =
              page.XMLHttpRequest;

        if (XHR?.prototype) {
            const originalOpen =
                  XHR.prototype.open;

            const originalSend =
                  XHR.prototype.send;

            XHR.prototype.open =
                function (
            method,
             url,
             ...rest
            ) {
                try {
                    this.__hbrUrl =
                        new page.URL(
                        url,
                        page.location.href
                    ).href;
                } catch {
                    this.__hbrUrl =
                        String(url || '');
                }

                return originalOpen.call(
                    this,
                    method,
                    url,
                    ...rest
                );
            };

            XHR.prototype.send =
                function (...args) {
                this.addEventListener(
                    'load',
                    function () {
                        try {
                            if (
                                this.status < 200 ||
                                this.status >= 300
                            ) {
                                return;
                            }

                            const type =
                                  this.getResponseHeader(
                                      'content-type'
                                  ) || '';

                            if (
                                !type
                                .toLowerCase()
                                .includes('json')
                            ) {
                                return;
                            }

                            let payload;

                            if (
                                this.responseType === 'json'
                            ) {
                                payload = this.response;
                            } else if (
                                !this.responseType ||
                                this.responseType === 'text'
                            ) {
                                payload =
                                    JSON.parse(
                                    this.responseText
                                );
                            } else {
                                return;
                            }

                            publish(
                                this.__hbrUrl,
                                payload
                            );
                        } catch {
                            // Never interfere with Beatport.
                        }
                    },
                    {
                        once: true
                    }
                );

                return originalSend.apply(
                    this,
                    args
                );
            };
        }

        console.debug(
            '[Harmony Beatport Recovery] Beatport network interceptor installed.'
        );
    }

    // =========================================================================
    // Beatport passive release discovery
    // =========================================================================

    function ingestObservedBeatportPayload(payload, sourceUrl = '') {
        const data =
              inspectBeatportPayload(
                  payload,
                  sourceUrl
              );

        if (
            !data.releases.length &&
            !data.tracklists.length
        ) {
            return;
        }

        passiveCacheQueue =
            passiveCacheQueue
            .then(
            () =>
            ingestBeatportDataNow(
                data,
                sourceUrl,
                'network'
            )
        )
            .catch(
            error => {
                console.warn(
                    '[Harmony Beatport Recovery] Could not ingest Beatport data.',
                    error
                );
            }
        );
    }

    function setupBeatportNetworkReceiver() {
        if (!isBeatport()) {
            return;
        }

        window.addEventListener(
            'message',
            event => {
                if (
                    event.origin !==
                    location.origin
                ) {
                    return;
                }

                const message =
                      event.data;

                if (
                    message?.channel !==
                    NETWORK_CHANNEL
                ) {
                    return;
                }

                ingestObservedBeatportPayload(
                    message.payload,
                    message.url
                );
            }
        );
    }

    async function ingestEmbeddedBeatportData() {
        const data = {
            releases: [],
            tracklists: []
        };

        for (
            const root
            of jsonRoots()
        ) {
            const found =
                  inspectBeatportPayload(
                      root,
                      location.href
                  );

            data.releases.push(
                ...found.releases
            );

            data.tracklists.push(
                ...found.tracklists
            );
        }

        if (
            !data.releases.length &&
            !data.tracklists.length
        ) {
            return [];
        }

        await ingestBeatportDataNow(
            data,
            location.href,
            'embedded JSON'
        );

        return data.releases;
    }

    // =========================================================================
    // Shared track normalization helper
    // =========================================================================

    function trackArtists(track) {
        return (
            track?.artists ||
            []
        )
            .map(
            artist => ({
                id:
                artist.id ??
                artist.artist_id ??
                null,

                name:
                artist.name ??
                artist.artist_name ??
                null
            })
        )
            .filter(
            artist =>
            artist.name
        );
    }

    // =========================================================================
    // Harmony Beatport URL helper: release ID -> UPC
    // =========================================================================

    function stripUrlResolverParams() {
        try {
            const url =
                  new URL(
                      location.href
                  );

            let changed =
                false;

            for (
                const name
                of [
                    'hbr_resolve',
                    'hbr_release'
                ]
            ) {
                if (
                    url.searchParams.has(
                        name
                    )
                ) {
                    url.searchParams.delete(
                        name
                    );

                    changed =
                        true;
                }
            }

            if (changed) {
                history.replaceState(
                    history.state,
                    '',
                    url.toString()
                );
            }
        } catch {
            /*
         * Cosmetic only.
         */
        }
    }

    function loadBeatportUrlResolverSession() {
        const url =
              new URL(
                  location.href
              );

        const id =
              clean(
                  url.searchParams.get(
                      'hbr_resolve'
                  )
              );

        const releaseId =
              clean(
                  url.searchParams.get(
                      'hbr_release'
                  )
              );

        /*
     * First visit from Harmony.
     */
        if (
            id &&
            /^\d+$/.test(
                releaseId
            )
        ) {
            const session = {
                requestId:
                id,

                releaseId,

                startedAt:
                Date.now()
            };

            sessionStorage.setItem(
                URL_RESOLVER_SESSION_KEY,
                JSON.stringify(
                    session
                )
            );

            stripUrlResolverParams();

            return session;
        }

        /*
     * Preserve the resolver if Beatport itself causes a same-tab reload.
     */
        try {
            const stored =
                  JSON.parse(
                      sessionStorage.getItem(
                          URL_RESOLVER_SESSION_KEY
                      ) ||
                      'null'
                  );

            if (
                stored?.requestId &&
                /^\d+$/.test(
                    String(
                        stored?.releaseId ||
                        ''
                    )
                )
            ) {
                return {
                    ...stored,

                    releaseId:
                    String(
                        stored.releaseId
                    )
                };
            }
        } catch {
            /*
         * Ignore invalid session data.
         */
        }

        return null;
    }

    function clearBeatportUrlResolverSession() {
        sessionStorage.removeItem(
            URL_RESOLVER_SESSION_KEY
        );

        urlResolverSession =
            null;

        if (
            urlResolverReleaseListener !=
            null
        ) {
            GM_removeValueChangeListener(
                urlResolverReleaseListener
            );

            urlResolverReleaseListener =
                null;
        }
    }

    function beatportUrlResolverPanel(session) {
        let panel =
            document.getElementById(
                'hbr-beatport-url-resolver'
            );

        panel ||=
            document.body.appendChild(
            el(
                'div',
                {
                    id: 'hbr-beatport-url-resolver',
                    style: {
                        position: 'fixed',
                        top: '20px',
                        right: '20px',
                        zIndex: '2147483647',
                        background: '#181818',
                        color: '#fff',
                        border: '2px solid #ff9800',
                        borderRadius: '8px',
                        padding: '12px 14px',
                        fontFamily: 'Arial, sans-serif',
                        fontSize: '13px'
                    }
                }
            )
        );

        panel.textContent =
            'Harmony Beatport Recovery: ' +
            `waiting for UPC from release ${session.releaseId}…`;
    }

    async function refreshBeatportUrlResolver() {
        const session =
              urlResolverSession;

        if (!session) {
            return false;
        }

        /*
     * The universal Beatport scraper owns this record.
     * This helper only reads it.
     */
        const record =
              await getCachedRelease(
                  session.releaseId
              );

        if (
            urlResolverSession !==
            session ||
            !clean(
                record
                ?.release
                ?.upc
            )
        ) {
            return false;
        }

        console.debug(
            '[Harmony Beatport Recovery] ' +
            'URL helper resolved release UPC state.',
            {
                releaseId:
                session.releaseId,

                upc:
                record.release.upc
            }
        );

        await GM_setValue(
            `${URL_RESULT_PREFIX}${session.requestId}`,

            {
                requestId:
                session.requestId,

                releaseId:
                session.releaseId,

                upc:
                record.release.upc,

                timestamp:
                Date.now()
            }
        );

        clearBeatportUrlResolverSession();

        stripUrlResolverParams();

        window.close();

        return true;
    }

    async function initBeatportUrlResolver() {
        urlResolverSession =
            loadBeatportUrlResolverSession();

        if (!urlResolverSession) {
            return false;
        }

        beatportUrlResolverPanel(
            urlResolverSession
        );

        /*
     * The embedded scraper may already have populated the record
     * before this listener is installed, so we both listen AND
     * perform an immediate read below.
     */
        urlResolverReleaseListener =
            GM_addValueChangeListener(
            cacheKey(
                urlResolverSession
                .releaseId
            ),

            () =>
            refreshBeatportUrlResolver()
            .catch(
                error =>
                console.warn(
                    '[Harmony Beatport Recovery] ' +
                    'Beatport URL resolver cache watch failed.',
                    error
                )
            )
        );

        await refreshBeatportUrlResolver();

        return true;
    }

    // =========================================================================
    // Harmony helper tab: cache monitoring only
    // =========================================================================

    function helperTargetLabel(level) {
        return Number(level) >= LEVEL.TRACKS
            ? 'Release + track data'
        : 'Release metadata';
    }

    function currentBeatportReleaseId() {
        const match =
              location.pathname.match(
                  /^\/release\/[^/]+\/(\d+)\/?$/
              );

        return match
            ? String(match[1])
        : '';
    }

    function stripHelperUrlParams() {
        try {
            const url =
                  new URL(
                      location.href
                  );

            let changed = false;

            for (
                const name
                of [
                    'hbr',
                    'hbr_upc',
                    'hbr_level'
                ]
            ) {
                if (
                    url.searchParams.has(name)
                ) {
                    url.searchParams.delete(name);
                    changed = true;
                }
            }

            if (changed) {
                history.replaceState(
                    history.state,
                    '',
                    url.toString()
                );
            }
        } catch {
            // Cosmetic only.
        }
    }

    function loadBeatportHelperSession() {
        const url =
              new URL(
                  location.href
              );

        const requestIdFromUrl =
              clean(
                  url.searchParams.get('hbr')
              );

        const upcFromUrl =
              barcode(
                  url.searchParams.get(
                      'hbr_upc'
                  )
              );

        const levelFromUrl =
              Number(
                  url.searchParams.get(
                      'hbr_level'
                  )
              );

        /*
     * The first Harmony-created URL seeds a session local to this
     * Beatport tab. sessionStorage then follows the user through
     * subsequent Beatport navigation even though ?hbr disappears.
     */
        if (
            requestIdFromUrl &&
            upcFromUrl &&
            [LEVEL.RELEASE, LEVEL.TRACKS]
            .includes(levelFromUrl)
        ) {
            const session = {
                requestId:
                requestIdFromUrl,

                upc:
                upcFromUrl,

                targetLevel:
                levelFromUrl,

                startedAt:
                Date.now()
            };

            sessionStorage.setItem(
                HELPER_SESSION_KEY,
                JSON.stringify(session)
            );

            /*
         * The query parameters are only bootstrap information.
         * Removing them means manual browsing produces ordinary
         * Beatport URLs while the helper survives in sessionStorage.
         */
            stripHelperUrlParams();

            return session;
        }

        try {
            const stored =
                  JSON.parse(
                      sessionStorage.getItem(
                          HELPER_SESSION_KEY
                      ) ||
                      'null'
                  );

            const upc =
                  barcode(
                      stored?.upc
                  );

            const targetLevel =
                  Number(
                      stored?.targetLevel
                  );

            if (
                stored?.requestId &&
                upc &&
                [LEVEL.RELEASE, LEVEL.TRACKS]
                .includes(targetLevel)
            ) {
                return {
                    ...stored,
                    upc,
                    targetLevel
                };
            }
        } catch {
            sessionStorage.removeItem(
                HELPER_SESSION_KEY
            );
        }

        return null;
    }

    function clearBeatportHelperSession() {
        sessionStorage.removeItem(
            HELPER_SESSION_KEY
        );

        helperSession = null;
    }

    function clearBeatportHelperReleaseWatch() {
        removeGMListener(
            helperReleaseListener
        );

        helperReleaseListener = null;
        helperReleaseId = '';
    }

    function stopBeatportHelperWatch() {
        removeGMListener(
            helperUPCListener
        );

        helperUPCListener = null;

        clearBeatportHelperReleaseWatch();
    }

    function helperPanel(session, message, { manualHint = false } = {}) {
        $('#' + IDS.helper)?.remove();

        const panel =
              el('div', {
                  id: IDS.helper,
                  style: {
                      position: 'fixed',
                      top: '20px',
                      right: '20px',
                      width: '360px',
                      maxWidth: 'calc(100vw - 40px)',
                      zIndex: '2147483647',
                      background: '#181818',
                      color: '#fff',
                      border: '2px solid #ff9800',
                      borderRadius: '8px',
                      padding: '14px',
                      boxShadow:
                      '0 4px 20px rgba(0,0,0,.65)',
                      fontFamily:
                      'Arial, sans-serif',
                      fontSize: '13px',
                      lineHeight: '1.4'
                  }
              });

        panel.append(
            el('div', {
                text:
                'Harmony Beatport Recovery',
                style: {
                    color: '#ff9800',
                    fontWeight: 'bold',
                    fontSize: '16px',
                    marginBottom: '10px'
                }
            }),

            el(
                'div',
                {},
                el('strong', {
                    text: 'Target UPC: '
                }),
                session.upc
            ),

            el(
                'div',
                {},
                el('strong', {
                    text: 'Wanted: '
                }),
                helperTargetLabel(
                    session.targetLevel
                )
            ),

            el('hr'),

            el('div', {
                text: message
            })
        );

        if (manualHint) {
            panel.append(
                el('div', {
                    text:
                    'Search or browse Beatport manually. This tab will continue watching the cache and will resume automatically as soon as the requested UPC is seen.',
                    style: {
                        marginTop: '10px',
                        color: '#ddd'
                    }
                })
            );
        }

        const cancel =
              el('button', {
                  type: 'button',
                  text: 'Cancel recovery',
                  style: {
                      marginTop: '12px',
                      padding: '5px 9px',
                      cursor: 'pointer'
                  }
              });

        cancel.addEventListener(
            'click',
            () => {
                stopBeatportHelperWatch();
                clearBeatportHelperSession();
                stripHelperUrlParams();
                panel.remove();
            }
        );

        panel.append(cancel);

        document.body.append(panel);
    }

    function finishBeatportHelper(session, record) {
        stopBeatportHelperWatch();
        clearBeatportHelperSession();
        stripHelperUrlParams();

        /*
     * Normally GM_openInTab-created tabs can close themselves.
     * If the browser refuses, the completion notice remains visible.
     */
        helperPanel(
            session,
            `Recovered Beatport ${
            recordLevel(record) >= LEVEL.TRACKS
            ? 'release and track'
            : 'release'
            } data. This tab can be closed.`
        );

        window.close();
    }

    function watchBeatportHelperRelease(releaseId) {
        const id =
              String(releaseId);

        if (helperReleaseId === id) {
            return;
        }

        clearBeatportHelperReleaseWatch();

        helperReleaseId = id;

        helperReleaseListener =
            GM_addValueChangeListener(
            cacheKey(id),
            () =>
            refreshBeatportHelper()
            .catch(
                error =>
                console.warn(
                    '[Harmony Beatport Recovery] Helper cache watch failed.',
                    error
                )
            )
        );
    }

    async function refreshBeatportHelper() {
        const session =
              helperSession;

        if (!session) {
            return;
        }

        const state =
              await readCachedUPCState(
                  session.upc
              );

        /*
     * The helper may have been cancelled while awaiting storage.
     */
        if (
            helperSession !== session
        ) {
            return;
        }

        if (state.status === 'ambiguous') {
            clearBeatportHelperReleaseWatch();

            helperPanel(
                session,
                `More than one cached Beatport release uses UPC ${session.upc}.`,
                {
                    manualHint: true
                }
            );

            return;
        }

        /*
     * This is no longer an error or timeout.
     *
     * The user can search, open an artist/label page, change the
     * search terms, etc. The universal Beatport scraper keeps doing
     * its normal work and this listener waits for the UPC pointer.
     */
        if (!state.releaseId) {
            clearBeatportHelperReleaseWatch();

            helperPanel(
                session,
                `No Beatport release with UPC ${session.upc} has been seen yet.`,
                {
                    manualHint: true
                }
            );

            return;
        }

        watchBeatportHelperRelease(
            state.releaseId
        );

        const record =
              state.status === 'hit'
        ? state.record
        : await getCachedRelease(
            state.releaseId
        );

        if (
            !record?.release ||
            barcode(record.release.upc) !==
            session.upc
        ) {
            helperPanel(
                session,
                'The matching UPC was seen. Waiting for its release record to finish caching.'
            );

            return;
        }

        /*
     * Desired cache level reached. There is no event back to Harmony:
     * Harmony is independently watching this same cache record.
     */
        if (
            recordLevel(record) >=
            session.targetLevel
        ) {
            finishBeatportHelper(
                session,
                record
            );

            return;
        }

        /*
     * Level 1 identifies the exact Beatport release. If Level 2 was
     * requested, navigate to it. The universal scraper—not this
     * helper—will ingest the full release/track JSON and upgrade it.
     */
        if (
            session.targetLevel >= LEVEL.TRACKS
        ) {
            const releaseId =
                  String(
                      record.release.releaseId
                  );

            if (
                currentBeatportReleaseId() !==
                releaseId
            ) {
                helperPanel(
                    session,
                    'Matching release found. Opening its release page to retrieve full track data.'
                );

                location.href =
                    record.release.releaseUrl;

                return;
            }

            helperPanel(
                session,
                'Matching release found. Waiting for the universal scraper to cache the full tracklist.'
            );

            return;
        }

        helperPanel(
            session,
            'Matching release found. Waiting for the cache to finish updating.'
        );
    }

    async function initBeatportHelper() {
        helperSession =
            loadBeatportHelperSession();

        if (!helperSession) {
            return;
        }

        helperPanel(
            helperSession,
            `Watching Beatport for UPC ${helperSession.upc}.`,
            {
                manualHint: true
            }
        );

        helperUPCListener =
            GM_addValueChangeListener(
            upcKey(
                helperSession.upc
            ),
            () =>
            refreshBeatportHelper()
            .catch(
                error =>
                console.warn(
                    '[Harmony Beatport Recovery] Helper UPC watch failed.',
                    error
                )
            )
        );

        /*
     * Do an initial read as well as listening for future changes.
     * This handles a UPC that the universal scraper cached before
     * the helper listener finished initializing.
     */
        await refreshBeatportHelper();
    }

    // =========================================================================
    // Beatport entry
    // =========================================================================

    async function processBeatport() {
        await ingestEmbeddedBeatportData();

        if (
            await initBeatportUrlResolver()
        ) {
            return;
        }

        await initBeatportHelper();
    }

    if (isBeatport()) {
        setupBeatportNetworkReceiver();
        installBeatportNetworkInterceptor();
    }

    function init() {
        if (isHarmony()) {
            initHarmony();
        } else if (isBeatport()) {
            processBeatport();
        }
    }

    if (
        document.readyState === 'loading'
    ) {
        document.addEventListener(
            'DOMContentLoaded',
            init,
            { once: true }
        );
    } else {
        init();
    }
})();
