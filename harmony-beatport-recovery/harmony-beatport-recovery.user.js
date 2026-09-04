// ==UserScript==
// @name         Harmony: Beatport Recovery
// @namespace    https://github.com/djkhjg/musicbrainz-userscripts
// @version      1.3.0
// @description  Recovers and caches Beatport release and optional track metadata for Harmony.
// @author       djkhjg
// @license      MIT
// @homepageURL  https://github.com/djkhjg/musicbrainz-userscripts/tree/main/harmony-beatport-recovery
// @supportURL   https://github.com/djkhjg/musicbrainz-userscripts/issues
// @downloadURL  https://raw.github.com/djkhjg/musicbrainz-userscripts/main/harmony-beatport-recovery/harmony-beatport-recovery.user.js
// @updateURL    https://raw.github.com/djkhjg/musicbrainz-userscripts/main/harmony-beatport-recovery/harmony-beatport-recovery.user.js
// @match        https://harmony.pulsewidth.org.uk/release*
// @match        https://harmony.pulsewidth.org.uk/settings*
// @match        https://harmony.mybrainz.dev/release*
// @match        https://harmony.mybrainz.dev/settings*
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
    const DEBUG_CACHE_PRUNING = true;
    const DEBUG_RELEASE_ACTIONS = false;

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
    const HBR_VERSION = '1.3.0';
    const HBR_EDIT_NOTE_SUFFIX = `(via Beatport Recovery v${HBR_VERSION})`;
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
    const HBR_BEATPORT_DEFAULT_KEY ='hbr-beatport-default-v1';
    const HBR_PROVIDER_SELECTION_KEY ='hbr-provider-selection-v1';
    const HBR_MESSAGE_ID ='hbr-beatport-message';
    const HELPER_RESULT_PREFIX = 'hbr-helper-result-';

    const TRACK_SETTING_KEY = 'hbr-setting-track-data';
    const AUTO_SETTING_KEY = 'hbr-setting-auto';

    const LEVEL = { NONE: 0, RELEASE: 1, TRACKS: 2 };
    const MB = {
        download: '74',
        streaming: '980',

        entityDownload: {
            artist: '176',
            label: '959',
            recording: '254'
        }
    };
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

    const MPL_FLOW_STATUS_KEY = 'harmony-provider-flow:mpl';
    const HBR_FLOW_STATUS_KEY = 'harmony-provider-flow:hbr';

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
    let beatportRequestedForThisLookup = null;

    let helperSession = null;
    let helperUPCListener = null;
    let helperReleaseListener = null;
    let helperReleaseId = '';
    let harmonyUrlResolve = null;

    let urlResolverSession = null;
    let urlResolverReleaseListener = null;
    let mplRetryTimer = null;
    let suppressHbrLookupThisLoad = false;

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
    const isHarmonyReleaseActions = () => isHarmony() && location.pathname === '/release/actions';
    const isHarmonySettings = () => isHarmony() && location.pathname === '/settings';
    const isBeatport = () => location.hostname === 'www.beatport.com';

    const helperResultKey = requestId => `${HELPER_RESULT_PREFIX}${requestId}`;

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

    function setHbrFlowStatus(status) {
        sessionStorage.setItem(
            HBR_FLOW_STATUS_KEY,
            status
        );
    }

    function getHbrFlowStatus() {
        return sessionStorage.getItem(
            HBR_FLOW_STATUS_KEY
        );
    }

    function mplAllowsHbr() {
        // wait for MPL if it is installed
        const status =
              sessionStorage.getItem(
                  MPL_FLOW_STATUS_KEY
              );

        return (
            status === null ||
            status === 'finished'
        );
    }

    function consumeHbrReturnLoad() {
        // Checks if HBR loaded the page (generally by URL->UPC entry)
        if (
            getHbrFlowStatus() !==
            'busy'
        ) {
            return false;
        }

        setHbrFlowStatus(
            'finished'
        );

        return true;
    }

    function scheduleMplBeatportRecheck() {
        if (mplRetryTimer != null) {
            return;
        }

        mplRetryTimer =
            setTimeout(
            () => {
                mplRetryTimer =
                    null;

                scheduleHarmonyCheck();
            },
            250
        );
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

    function debugReleaseActions(...args) {
        if (!DEBUG_RELEASE_ACTIONS) {
            return;
        }

        console.log(
            '[Harmony Beatport Recovery] [Release Actions]',
            ...args
        );
    }

    // =========================================================================
    // Settings Page
    // =========================================================================

    function getBeatportDefault() {
        return (
            localStorage.getItem(
                HBR_BEATPORT_DEFAULT_KEY
            ) === '1'
        );
    }

    function setBeatportDefault(enabled) {
        localStorage.setItem(
            HBR_BEATPORT_DEFAULT_KEY,
            enabled
            ? '1'
            : '0'
        );
    }

    function getBeatportSelection() {
        const stored =
              sessionStorage.getItem(
                  HBR_PROVIDER_SELECTION_KEY
              );

        if (stored !== null) {
            return (
                stored === '1'
            );
        }

        // Settings only drives initial default for a new
        // Harmony tab/session.
        const enabled =
              getBeatportDefault();

        sessionStorage.setItem(
            HBR_PROVIDER_SELECTION_KEY,
            enabled
            ? '1'
            : '0'
        );

        return enabled;
    }

    function setBeatportSelection(enabled) {
        sessionStorage.setItem(
            HBR_PROVIDER_SELECTION_KEY,
            enabled
            ? '1'
            : '0'
        );
    }

    function initHarmonySettings() {
        if (
            replaceHarmonyBeatportCheckbox(
                'settings'
            )
        ) {
            return;
        }

        const observer =
              new MutationObserver(
                  () => {
                      if (
                          replaceHarmonyBeatportCheckbox(
                              'settings'
                          )
                      ) {
                          observer.disconnect();
                      }
                  }
              );

        observer.observe(
            document.documentElement,
            {
                childList: true,
                subtree: true
            }
        );
    }

    // =========================================================================
    // Beatport Checkbox
    // =========================================================================

    function getHbrBeatportCheckbox(mode) {
        return $(
            `#hbr-${mode}-beatport-input`
        );
    }

    function replaceHarmonyBeatportCheckbox(mode) {
        const existing =
              getHbrBeatportCheckbox(
                  mode
              );

        if (existing) {
            return existing;
        }

        const nativeCheckbox =
              $('#beatport-input');

        if (!nativeCheckbox) {
            return null;
        }

        // Copy Harmony's visual checkbox but not its behavior.
        // Most importantly, this replacement has no `name`, so
        // submitting Harmony's form can never create &beatport=.
        const checkbox =
              nativeCheckbox.cloneNode(
                  false
              );

        checkbox.id =
            `hbr-${mode}-beatport-input`;

        checkbox.removeAttribute(
            'name'
        );

        checkbox.removeAttribute(
            'value'
        );

        checkbox.disabled =
            false;

        if (
            mode ===
            'settings'
        ) {
            checkbox.checked =
                getBeatportDefault();
        } else {
            checkbox.checked =
                getBeatportSelection();
        }

        const label =
              nativeCheckbox.closest(
                  '.provider-input'
              );

        const oldId =
              nativeCheckbox.id;

        nativeCheckbox.replaceWith(
            checkbox
        );

        if (label) {
            if (
                label.getAttribute(
                    'for'
                ) === oldId
            ) {
                label.setAttribute(
                    'for',
                    checkbox.id
                );
            }

            label.title =
                mode === 'settings'
                ? 'Beatport default managed by Harmony Beatport Recovery'
            : 'Beatport session selection managed by Harmony Beatport Recovery';
        }

        checkbox.addEventListener(
            'change',
            () => {
                if (
                    mode ===
                    'settings'
                ) {
                    setBeatportDefault(
                        checkbox.checked
                    );

                    return;
                }

                setBeatportSelection(
                    checkbox.checked
                );
            }
        );

        return checkbox;
    }

    function ensureBeatportSelectionSnapshot() {
        const checkbox =
              setupBeatportCheckbox();

        if (!checkbox) {
            return false;
        }

        if (
            beatportRequestedForThisLookup ===
            null
        ) {
            beatportRequestedForThisLookup =
                Boolean(
                checkbox.checked ||
                beatportReleaseIdFromUrl(
                    $('#url-input')?.value
                )
            );

            console.info(
                '[Harmony Beatport Recovery]',
                `Beatport requested for this lookup: ${
                beatportRequestedForThisLookup
                ? 'yes'
                : 'no'
                }`
            );
        }

        return true;
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

    // =========================================================================
    // Debug functions
    // =========================================================================

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
        //extract ID from the entered URL
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
        // make sure Harmony failed
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
              ensureBeatportMessage();

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
                        'Beatport URL recovery — '
                    }
                ),
                `retrying lookup by UPC ${clean(upc)}…`
            )
        );
    }

    function showBeatportNoUpcStatus(releaseId, releaseUrl) {
        // in case release has no UPC at all
        const message =
              ensureBeatportMessage();

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
                        'Beatport URL recovery'
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
        // Auto submit entered UPC
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

        showBeatportUpcRetryStatus(
            upc
        );

        sessionStorage.setItem(
            HARMONY_CLEAR_RESOLVED_UPC_KEY,
            '1'
        );

        setHbrFlowStatus(
            'busy'
        );

        form.requestSubmit();

        return true;
    }

    function clearResolvedUrlUpcField() {
        // clears temporary UPC field to match Harmony native URL-only lookup
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
        // This feature is deliberately post-Harmony-failure only.
        // If an explicit Beatport URL did not produce a Harmony release,
        // use the exact Beatport release to discover a UPC and retry the
        // normal Harmony lookup.
        if (
            !noProviderReturnedRelease()
        ) {
            return false;
        }

        // Once we have populated GTIN and rerun Harmony, do not attempt
        // URL resolution again even if the second lookup also fails.
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

        if (harmonyUrlResolve) {
            return true;
        }

        // Fast path:
        // the exact Beatport release is already in our cache.
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

            setHbrFlowStatus(
                'finished'
            );

            return true;
        }

        if (cachedUpc) {
            console.debug(
                '[Harmony Beatport Recovery] ' +
                'Beatport URL lookup resolved from cache.',
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

        // Cache miss:
        // open the exact Beatport release page.
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
                    'Beatport URL lookup resolved by Beatport helper.',
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

                    setHbrFlowStatus(
                        'finished'
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

        setHbrFlowStatus(
            'busy'
        );

        openBeatport(
            target.toString()
        );

        return true;
    }

    // =========================================================================
    // Harmony release identity / settings
    // =========================================================================

    // Harmony's canonical merged release title
    const releaseTitle = () => clean($('.release-title')?.textContent);

    // Harmony's canonical merged artist name
    function releaseArtist() {
        const container = $('.release-artist');

        return clean(
            container
            ?.querySelector('.artist-credit')
            ?.textContent ||
            container?.textContent
        );
    }

    // Barcode rendered in Harmony's release table
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

    const beatportEnabled = () => beatportRequestedForThisLookup === true;

    // Builds the backup artist+title search
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

    // track data & auto settings
    async function loadSettings() {
        settings.trackData = await GM_getValue(TRACK_SETTING_KEY, true);
        settings.auto = await GM_getValue(AUTO_SETTING_KEY, false);
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
        return (
            replaceHarmonyBeatportCheckbox(
                'lookup'
            )
        );
    }

    const messageContent = message =>
    $('.provider', message)?.nextElementSibling ||
          message.lastElementChild ||
          message;

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

    function settingsPanel({
        showTrackData = true,
        onAuto = maybeAutoLookup
    } = {}) {
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

                if (
                    settings.auto &&
                    typeof onAuto === 'function'
                ) {
                    onAuto();
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

                if (
                    settings.auto &&
                    typeof onAuto === 'function'
                ) {
                    onAuto();
                }
            }
        );

        const panel =
              el(
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
                  }
              );

        if (showTrackData) {
            panel.append(
                el(
                    'label',
                    {
                        title:
                        'Open the exact Beatport release page and retrieve track titles, artists and ISRCs.'
                    },
                    track,
                    ' Retrieve track data'
                )
            );
        }

        panel.append(
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

        return panel;
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
                typeof GM_openInTab ===
                'function'
            ) {
                return GM_openInTab(
                    url,
                    {
                        active: true,
                        insert: true,
                        setParent: true
                    }
                );
            }
        } catch {
            // Fall through.
        }

        return window.open(
            url,
            '_blank'
        );
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

        // Once the requested cache level is already available, this
        // is ordinary browsing rather than a recovery session.
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

        const resultKey =
              helperResultKey(
                  id
              );

        await GM_deleteValue(
            resultKey
        );

        setHbrFlowStatus(
            'busy'
        );

        const helperTab =
              openBeatport(
                  target.toString()
              );

        // One helper tab owns the whole recovery attempt. If it finds
        // Level 1 while Level 2 is wanted, that same tab will navigate
        // itself to the exact release page.
        autoStartedFor =
            `${gtin}|${plan.targetLevel}`;

        if (
            helperTab &&
            typeof helperTab ===
            'object'
        ) {
            helperTab.onclose =
                async () => {
                const result =
                      await GM_getValue(
                          resultKey,
                          null
                      );

                // A successful helper writes its terminal state before
                // closing itself. That close is normal and must not be
                // interpreted as a user cancellation.
                if (
                    result?.requestId === id &&
                    result?.state ===
                    'success'
                ) {
                    await GM_deleteValue(
                        resultKey
                    );

                    return;
                }

                // Explicit Cancel writes "skipped".
                // No result at all means the user manually closed the
                // Beatport helper tab, which is also a skip.
                await finishSkippedBeatportLookup(
                    id
                );
            };
        }

        return true;
    }

    function recoveryButton({
        text = 'Find on Beatport',
        onClick = startLookup
    } = {}) {
        const button = el('button', {
            id: IDS.button,
            type: 'button',
            text,
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
            onClick(
                button
            )
        );

        return button;
    }

    function ensureRecoveryControls() {
        if (!beatportEnabled()) {
            return false;
        }

        const message = ensureBeatportMessage();

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
            suppressHbrLookupThisLoad
        ) {
            return;
        }

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

        // Deliberately ignore search/release stage here.
        // One helper tab is responsible for the entire request. Once
        // that helper discovers Level 1 it will navigate itself to the
        // release page when Level 2 is required.
        const key =
              `${barcode(harmonyBarcode())}|${plan.targetLevel}`;

        if (
            autoStartedFor === key
        ) {
            return;
        }

        const started =
              await startLookup(
                  $('#' + IDS.button)
              );

        if (!started) {
            autoStartedFor = null;
        }
    }

    function showBeatportSkippedStatus() {
        const message =
              ensureBeatportMessage();

        if (!message) {
            return;
        }

        const content =
              messageContent(
                  message
              );

        message.classList.remove(
            'error'
        );

        message.style.borderColor =
            '#999';

        content.replaceChildren(
            el(
                'p',
                {},
                el(
                    'strong',
                    {
                        text:
                        'Beatport skipped'
                    }
                )
            ),

            el(
                'p',
                {
                    text:
                    'Beatport recovery was skipped for this lookup.'
                }
            )
        );
    }

    async function finishSkippedBeatportLookup(requestId) {
        await GM_deleteValue(
            helperResultKey(
                requestId
            )
        );

        // Do not let Auto immediately launch another helper for
        // this same page after the user deliberately skipped it.
        suppressHbrLookupThisLoad =
            true;

        autoStartedFor =
            null;

        showBeatportSkippedStatus();

        setHbrFlowStatus(
            'finished'
        );

        console.info(
            '[Harmony Beatport Recovery] Beatport skipped for this lookup.'
        );
    }

    // =========================================================================
    // Harmony release UI
    // =========================================================================

    function suppressBeatportFailureMessage(message = beatportFailureMessage()) {
        if (!message) {
            return;
        }

        message.style.display =
            'none';
    }

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

        // Put the recovered label near the other release metadata.
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
        const message = ensureBeatportMessage();

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

    function beatportMessage() {
        return $(
            `#${HBR_MESSAGE_ID}`
        );
    }

    function ensureBeatportMessage() {
        let message =
            beatportMessage();

        if (message) {
            return message;
        }

        const host =
              $('.release') ||
              $('main');

        if (!host) {
            return null;
        }

        message =
            el(
            'div',
            {
                id:
                HBR_MESSAGE_ID,

                class:
                'message info'
            },

            beatportIcon(
                24,
                2
            ),

            el(
                'span',
                {
                    class:
                    'provider',

                    text:
                    'Beatport Recovery:'
                }
            ),

            el(
                'div'
            )
        );

        if (
            isHarmonyReleaseActions()
        ) {

            //Release Actions placement
            const actionsHeading =
                  $$('h2', host)
            .find(
                heading =>
                clean(
                    heading.textContent
                ) ===
                'Release Actions'
            );

            if (actionsHeading) {
                actionsHeading.after(
                    message
                );
            } else {
                host.append(
                    message
                );
            }
        } else {

            // Release Lookup placement
            const releaseTitle =
                  $('.release-title', host);

            if (releaseTitle) {
                host.insertBefore(
                    message,
                    releaseTitle
                );
            } else {
                host.append(
                    message
                );
            }
        }

        return message;
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

        // Harmony puts linked provider icons inside an entity-links
        // group ahead of the displayed value.
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

        // Ignore Beatport alternatives that we may already have
        // inserted into this cell.
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

                // Remove the whitespace we inserted immediately before
                // a matching provider icon.
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

        // Best case: Harmony already seeded the same label.
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

        // Harmony omitted the Beatport label:
        // Don't attach Beatport's catalog number to some unrelated
        // label. Add Beatport as a new label entry instead.
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

        // The label itself is worth seeding even when Beatport has no
        // catalog number.
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
              `* Beatport: ${release.releaseUrl} ${HBR_EDIT_NOTE_SUFFIX}`;

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

    function ensureBeatportRedirectState(form, release) {
        if (
            !release?.releaseId ||
            !release.releaseUrl
        ) {
            return;
        }

        const field =
              $('[name="redirect_uri"]', form);

        if (
            !field ||
            !clean(field.value)
        ) {
            return;
        }

        let redirect;

        try {
            redirect =
                new URL(
                field.value,
                location.href
            );
        } catch {
            return;
        }

        if (
            redirect.pathname !==
            '/release/actions'
        ) {
            return;
        }

        // Never use Beatport as a native provider parameter.
        redirect.searchParams.delete(
            'beatport'
        );

        const releaseId =
              String(
                  release.releaseId
              );

        const alreadyPresent =
              redirect.searchParams
        .getAll(
            'url'
        )
        .some(
            value =>
            beatportReleaseIdFromUrl(
                value
            ) === releaseId
        );

        if (!alreadyPresent) {
            redirect.searchParams.append(
                'url',
                release.releaseUrl
            );
        }

        field.value =
            redirect.toString();

        field.dataset.hbrBeatport =
            '1';

        debugReleaseActions(
            'Added Beatport release URL to Harmony redirect state.',
            {
                releaseId,
                releaseUrl:
                release.releaseUrl,

                redirect:
                field.value
            }
        );
    }

    function patchSeed(form, release) {
        if (
            !beatportEnabled() ||
            !release
        ) {
            return;
        }

        const name =
              form.getAttribute(
                  'name'
              );

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
            name ===
            'release-seeder'
        ) {

            // New release imports need to carry Beatport forward into
            // Release Actions because Harmony cannot preserve a failed
            // provider itself.
            // Update seeds are intentionally different: Harmony leaves
            // their Release Actions redirect MBID-only so it can rebuild
            // the complete provider set from the existing MusicBrainz
            // release. Do not alter that redirect.
            ensureBeatportRedirectState(
                form,
                release
            );

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
                `[Harmony Beatport Recovery] Activated for requested Beatport lookup UPC ${upc}.`
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
            !$('.release') ||
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

        if (
            !ensureBeatportSelectionSnapshot()
        ) {
            return;
        }
        suppressBeatportFailureMessage();

        const upc =
              barcode(
                  harmonyBarcode()
              );

        // HBR does not make any provider-recovery decision until
        // MPL has either finished or is not participating.
        if (!mplAllowsHbr()) {
            scheduleMplBeatportRecheck();

            return;
        }

        // URL -> UPC recovery.
        // Once MPL has released HBR, URL-only Beatport failures may
        // bootstrap themselves through:
        // release URL -> release ID -> cache -> UPC -> Harmony retry.
        if (!upc) {
            const handled =
                  await resolveFailedBeatportUrlLookup();

            if (handled) {
                return;
            }

            // Harmony has reached a terminal state in which HBR has
            // no usable UPC and URL recovery does not apply.
            if (
                $('.provider-list') ||
                noProviderReturnedRelease()
            ) {
                setHbrFlowStatus(
                    'finished'
                );
            }

            return;
        }

        if (
            activatedUPC !== upc
        ) {
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
            setHbrFlowStatus(
                'finished'
            );

            return;
        }

        // From this point onward Harmony never performs another
        // Beatport lookup. It simply watches the UPC pointer and,
        // once known, that release's cache record.
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
                harmonyUiReady(
                    activeRecord
                )
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

            const have =
                  recordLevel(
                      activeRecord
                  );

            const want =
                  desiredLevel();

            // The requested Beatport data is now present on this same
            // Harmony page. Any HBR helper that produced it has finished,
            // so release the next provider in the chain.
            if (
                have >= want
            ) {
                setHbrFlowStatus(
                    'finished'
                );
            } else if (
                getHbrFlowStatus() !==
                'busy'
            ) {

                // Missing data remains, but HBR is not automatically
                // retrieving it. For example Auto may be disabled and
                // the user has only been offered a manual button.
                setHbrFlowStatus(
                    'finished'
                );
            }

            return;
        }

        if (ensureBeatportMessage()) {
            if (
                controlsReadyUPC !== upc &&
                ensureRecoveryControls()
            ) {
                controlsReadyUPC =
                    upc;
            }

            await maybeAutoLookup();

        }

        // If no helper was launched, HBR has finished its automatic
        // work even though a manual recovery option may remain.
        if (
            getHbrFlowStatus() !==
            'busy'
        ) {
            setHbrFlowStatus(
                'finished'
            );
        }
    }

    // =========================================================================
    // Harmony Release Actions
    // =========================================================================

    let releaseActionsStarted = false;
    let releaseActionsReleaseListener = null;
    let releaseActionsQueue = Promise.resolve();

    let lastMbRequestAt = 0;

    function normalizeIsrc(value) {
        const normalized =
              clean(
                  value
              )
        .toUpperCase()
        .replace(
            /[^A-Z0-9]/g,
            ''
        );

        return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(
            normalized
        )
            ? normalized
        : '';
    }

    function musicBrainzApiUrl(type, id = '') {
        const url =
              new URL(
                  `https://musicbrainz.org/ws/2/${type}${id ? `/${id}` : ''}`
              );

        url.searchParams.set(
            'fmt',
            'json'
        );

        return url;
    }

    async function musicBrainzJson(url) {
        const elapsed =
              Date.now() -
              lastMbRequestAt;

        if (elapsed < 1100) {
            const delay =
                  1100 - elapsed;

            debugReleaseActions(
                `Waiting ${delay} ms before MusicBrainz request.`
            );

            await new Promise(
                resolve =>
                setTimeout(
                    resolve,
                    delay
                )
            );
        }

        lastMbRequestAt =
            Date.now();

        debugReleaseActions(
            'MusicBrainz request:',
            url.toString()
        );

        let response;

        try {
            response =
                await fetch(
                url,
                {
                    headers: {
                        Accept:
                        'application/json'
                    }
                }
            );
        } catch (error) {
            debugReleaseActions(
                'MusicBrainz fetch threw before receiving a response.',
                {
                    url:
                    url.toString(),

                    error
                }
            );

            throw error;
        }

        debugReleaseActions(
            'MusicBrainz response:',
            {
                url:
                response.url,

                status:
                response.status,

                ok:
                response.ok,

                type:
                response.type
            }
        );

        if (!response.ok) {
            const error =
                  new Error(
                      `MusicBrainz API returned ${response.status} for ${url}`
                  );

            error.hbrMusicBrainz =
                true;

            error.status =
                response.status;

            error.url =
                url.toString();

            throw error;
        }

        const json =
              await response.json();

        debugReleaseActions(
            'MusicBrainz JSON parsed.',
            json
        );

        return json;
    }

    function releaseActionsMbid() {
        const value =
              new URL(
                  location.href
              ).searchParams.get(
                  'release_mbid'
              );

        const match =
              clean(value).match(
                  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
              );

        return match
            ? match[0].toLowerCase()
        : '';
    }

    function releaseActionsExistingIsrcs() {
        const link =
              $('.magic-isrc');

        if (!link) {
            return [];
        }

        try {
            const url =
                  new URL(
                      link.href,
                      location.href
                  );

            return [
                ...url.searchParams
            ]
                .filter(
                ([name]) =>
                /^isrc\d+$/i.test(
                    name
                )
            )
                .map(
                ([, value]) =>
                normalizeIsrc(
                    value
                )
            )
                .filter(Boolean);
        } catch {
            return [];
        }
    }

    async function fetchMbReleaseStructure(releaseMbid) {
        const url =
              musicBrainzApiUrl(
                  'release',
                  releaseMbid
              );

        url.searchParams.set(
            'inc',
            [
                'artist-credits',
                'labels',
                'recordings',
                'isrcs'
            ].join('+')
        );

        return musicBrainzJson(
            url
        );
    }

    async function fetchMbReleaseEntities(entityType, releaseMbid, includes = 'url-rels') {
        const url =
              musicBrainzApiUrl(
                  entityType
              );

        url.searchParams.set(
            'release',
            releaseMbid
        );

        url.searchParams.set(
            'inc',
            includes
        );

        url.searchParams.set(
            'limit',
            '100'
        );

        const result =
              await musicBrainzJson(
                  url
              );

        const key = {
            artist: 'artists',
            label: 'labels',
            recording: 'recordings'
        }[entityType];

        return (
            result?.[key] ||
            []
        );
    }

    async function fetchMbReleaseEntitiesSafe(entityType, releaseMbid, includes = 'url-rels') {
        try {
            return {
                ok:
                true,

                entities:
                await fetchMbReleaseEntities(
                    entityType,
                    releaseMbid,
                    includes
                ),

                error:
                null
            };
        } catch (error) {
            console.warn(
                `[Harmony Beatport Recovery] Release Actions ${entityType} lookup failed.`,
                error
            );

            debugReleaseActions(
                `MusicBrainz ${entityType} browse failed.`,
                error
            );

            return {
                ok:
                false,

                entities:
                [],

                error
            };
        }
    }

    function mbReleaseTracks(release) {
        return (
            release?.media ||
            []
        ).flatMap(
            medium =>
            medium?.tracks ||
            []
        );
    }

    function mbReleaseArtists(release) {
        const result =
              new Map();

        const addCredit =
              credit => {
                  const artist =
                        credit?.artist;

                  if (
                      !artist?.id ||
                      !clean(
                          artist.name
                      )
                  ) {
                      return;
                  }

                  result.set(
                      artist.id,
                      {
                          mbid:
                          artist.id,

                          name:
                          artist.name
                      }
                  );
              };

        (
            release?.['artist-credit'] ||
            []
        ).forEach(
            addCredit
        );

        for (
            const track
            of mbReleaseTracks(
                release
            )
        ) {
            (
                track?.['artist-credit'] ||
                track?.recording?.['artist-credit'] ||
                []
            ).forEach(
                addCredit
            );
        }

        return [
            ...result.values()
        ];
    }

    function mbReleaseLabels(release) {
        return (
            release?.['label-info'] ||
            []
        )
            .map(
            info => ({
                mbid:
                info?.label?.id ||
                '',

                name:
                clean(
                    info?.label?.name
                ),

                catalogNumber:
                clean(
                    info?.['catalog-number']
                )
            })
        )
            .filter(
            label =>
            label.mbid &&
            label.name
        );
    }

    function flattenMbReleaseTracks(mbRelease) {
        return (
            mbRelease?.media ||
            []
        )
            .flatMap(
            medium =>
            medium?.tracks ||
            []
        );
    }

    function beatportReleaseArtists(release) {
        const result =
              new Map();

        const addArtist =
              artist => {
                  if (
                      artist?.id == null ||
                      !clean(
                          artist.name
                      )
                  ) {
                      return;
                  }

                  result.set(
                      String(
                          artist.id
                      ),
                      artist
                  );
              };

        (
            release?.artists ||
            []
        ).forEach(
            addArtist
        );

        if (
            release?.tracklistComplete
        ) {
            for (
                const track
                of release.tracks ||
                []
            ) {
                (
                    track?.artists ||
                    []
                ).forEach(
                    addArtist
                );
            }
        }

        return [
            ...result.values()
        ];
    }

    function findUniqueNameMatch(name, candidates) {
        const wanted =
              normalizeName(
                  name
              );

        if (!wanted) {
            return null;
        }

        const matches =
              candidates.filter(
                  candidate =>
                  normalizeName(
                      candidate.name
                  ) ===
                  wanted
              );

        return matches.length === 1
            ? matches[0]
        : null;
    }

    function beatportLabelUrl(label) {
        if (
            label?.id == null
        ) {
            return null;
        }

        return (
            `https://www.beatport.com/label/` +
            `${slugify(label.name || 'label')}/` +
            `${label.id}`
        );
    }

    // Reduce a Beatport entity URL to its stable identity.
    // The slug is cosmetic. If MusicBrainz contains:
    //   /artist/old-slug/123
    // and Beatport now gives:
    //   /artist/new-slug/123
    // those are still the same external entity and should not be
    // suggested twice.
    function beatportEntityIdentity(url) {
        try {
            const parsed =
                  new URL(url);

            if (
                parsed.hostname !==
                'www.beatport.com'
            ) {
                return '';
            }

            const parts =
                  parsed.pathname
            .split('/')
            .filter(Boolean);

            if (
                parts.length >= 4 &&
                /^[a-z]{2}$/i.test(
                    parts[0]
                )
            ) {
                parts.shift();
            }

            const type =
                  parts[0];

            const id =
                  parts.at(-1);

            if (
                ![
                    'artist',
                    'label',
                    'release',
                    'track'
                ].includes(type) ||
                !/^\d+$/.test(id)
            ) {
                return '';
            }

            return (
                `${type}:` +
                `${id}`
            );
        } catch {
            return '';
        }
    }

    function mbEntityRelations(entity) {
        return (
            entity?.relations ||
            []
        )
            .map(
            relation =>
            relation?.url
            ?.resource
        )
            .filter(Boolean);
    }

    function alreadyHasBeatportUrl(mbEntity, beatportUrl) {
        const wantedIdentity =
              beatportEntityIdentity(
                  beatportUrl
              );

        if (!wantedIdentity) {
            return false;
        }

        return mbEntityRelations(
            mbEntity
        ).some(
            existing =>
            beatportEntityIdentity(
                existing
            ) ===
            wantedIdentity
        );
    }

    function entityCacheMap(entities) {
        return new Map(
            (
                entities ||
                []
            )
            .filter(
                entity =>
                entity?.id
            )
            .map(
                entity => [
                    entity.id,
                    entity
                ]
            )
        );
    }

    function makeReleaseActionCandidates(mbRelease, beatportRelease) {
        const candidates =
              [];

        //
        // ARTISTS
        //

        const mbArtists =
              mbReleaseArtists(
                  mbRelease
              );

        for (
            const artist
            of beatportReleaseArtists(
                beatportRelease
            )
        ) {
            const match =
                  findUniqueNameMatch(
                      artist.name,
                      mbArtists
                  );

            if (!match) {
                console.warn(
                    '[Harmony Beatport Recovery] Could not uniquely match Beatport artist to MusicBrainz artist.',
                    artist
                );

                continue;
            }

            const url =
                  beatportArtistUrl(
                      artist
                  );

            if (!url) {
                continue;
            }

            candidates.push({
                entityType:
                'artist',

                mbid:
                match.mbid,

                name:
                match.name,

                beatportUrl:
                url,

                linkTypeId:
                MB.entityDownload
                .artist
            });
        }


        //
        // LABEL
        //

        if (
            beatportRelease?.label
            ?.id != null &&
            clean(
                beatportRelease.label
                .name
            )
        ) {
            const mbLabels =
                  mbReleaseLabels(
                      mbRelease
                  );

            const match =
                  findUniqueNameMatch(
                      beatportRelease
                      .label.name,
                      mbLabels
                  );

            if (match) {
                candidates.push({
                    entityType:
                    'label',

                    mbid:
                    match.mbid,

                    name:
                    match.name,

                    beatportUrl:
                    beatportLabelUrl(
                        beatportRelease
                        .label
                    ),

                    linkTypeId:
                    MB.entityDownload
                    .label
                });
            } else {
                console.warn(
                    '[Harmony Beatport Recovery] Could not uniquely match Beatport label to MusicBrainz label.',
                    beatportRelease.label
                );
            }
        }


        //
        // RECORDINGS
        //
        // Harmony structurally merges provider tracklists by position.
        // We do the same, but retain a sanity check because HBR is
        // operating outside Harmony's makeReleasesCompatible() stage.
        //

        if (
            beatportRelease
            ?.tracklistComplete &&
            Array.isArray(
                beatportRelease.tracks
            )
        ) {
            const mbTracks =
                  mbReleaseTracks(
                      mbRelease
                  );

            const bpTracks =
                  beatportRelease
            .tracks;

            if (
                mbTracks.length !==
                bpTracks.length
            ) {
                console.warn(
                    '[Harmony Beatport Recovery] Release Actions recording links skipped because MusicBrainz and Beatport track counts differ.',
                    {
                        musicBrainz:
                        mbTracks.length,

                        beatport:
                        bpTracks.length
                    }
                );
            } else {
                for (
                    let index = 0;
                    index <
                    mbTracks.length;
                    index++
                ) {
                    const mbTrack =
                          mbTracks[index];

                    const bpTrack =
                          bpTracks[index];

                    const recordingMbid =
                          mbTrack
                    ?.recording
                    ?.id;

                    if (
                        !recordingMbid ||
                        !bpTrack?.id
                    ) {
                        continue;
                    }

                    const mbTitle =
                          normalizeName(
                              mbTrack.title ||
                              mbTrack.recording
                              ?.title
                          );

                    const bpTitle =
                          normalizeName(
                              bpTrack.title
                          );

                    const mbIsrcs =
                          new Set(
                              (
                                  mbTrack
                                  ?.recording
                                  ?.isrcs ||
                                  []
                              )
                              .map(
                                  normalizeIsrc
                              )
                              .filter(Boolean)
                          );

                    const bpIsrc =
                          normalizeIsrc(
                              bpTrack.isrc
                          );

                    const titleMatches =
                          Boolean(
                              mbTitle &&
                              bpTitle &&
                              mbTitle ===
                              bpTitle
                          );

                    const isrcMatches =
                          Boolean(
                              bpIsrc &&
                              mbIsrcs.has(
                                  bpIsrc
                              )
                          );

                    // Position establishes correspondence, matching
                    // Harmony's own merge model.
                    // Title or ISRC confirms that position is sane.
                    if (
                        !titleMatches &&
                        !isrcMatches
                    ) {
                        console.warn(
                            '[Harmony Beatport Recovery] Release Actions recording match rejected.',
                            {
                                position:
                                index + 1,

                                musicBrainz:
                                {
                                    title:
                                    mbTrack.title,

                                    recordingMbid,

                                    isrcs:
                                    [
                                        ...mbIsrcs
                                    ]
                                },

                                beatport:
                                bpTrack
                            }
                        );

                        continue;
                    }

                    candidates.push({
                        entityType:
                        'recording',

                        mbid:
                        recordingMbid,

                        name:
                        mbTrack.title ||
                        mbTrack.recording
                        ?.title ||
                        bpTrack.title ||
                        '[unknown]',

                        beatportUrl:
                        trackUrl(
                            bpTrack
                        ),

                        linkTypeId:
                        MB.entityDownload
                        .recording
                    });
                }
            }
        }

        return candidates.filter(
            candidate =>
            candidate.beatportUrl
        );
    }

    function actionEditPrefix(entityType) {
        return (
            `edit-${entityType}`
        );
    }

    function candidateEditUrl(candidate, releaseMbid) {
        const url =
              new URL(
                  `https://musicbrainz.org/` +
                  `${candidate.entityType}/` +
                  `${candidate.mbid}/edit`
              );

        const prefix =
              actionEditPrefix(
                  candidate.entityType
              );

        url.searchParams.set(
            `${prefix}.url.0.text`,
            candidate.beatportUrl
        );

        url.searchParams.set(
            `${prefix}.url.0.link_type_id`,
            candidate.linkTypeId
        );

        url.searchParams.set(
            `${prefix}.edit_note`,
            `Matched ${candidate.entityType} while importing ` +
            `https://musicbrainz.org/release/${releaseMbid} with Harmony ` +
            HBR_EDIT_NOTE_SUFFIX
        );

        return url;
    }

    function ensureOpenAllRecordingLinksButton() {
        const recordingLinks =
              () =>
        $$('.action a[href]')
        .filter(
            link => {
                try {
                    return /^\/recording\/[^/]+\/edit$/.test(
                        new URL(
                            link.href,
                            location.href
                        ).pathname
                    );
                } catch {
                    return false;
                }
            }
        );

        const links =
              recordingLinks();

        if (!links.length) {
            return;
        }

        let button =
            $('button.open-all-links');

        // Create an "open all links" button if Harmony didn't
        if (!button) {
            const firstRecordingAction =
                  links[0]
            .closest(
                '.action'
            );

            if (!firstRecordingAction) {
                return;
            }

            let group =
                firstRecordingAction.closest(
                    '.action-group'
                );

            // put HBR recording actions into action group for the click-all button
            if (!group) {
                group =
                    el(
                    'div',
                    {
                        class:
                        'action-group'
                    }
                );

                firstRecordingAction.before(
                    group
                );

                for (
                    const link
                    of links
                ) {
                    const action =
                          link.closest(
                              '.action'
                          );

                    if (
                        action &&
                        action.parentElement !==
                        group
                    ) {
                        group.append(
                            action
                        );
                    }
                }
            }

            const openAllAction =
                  el(
                      'div',
                      {
                          class:
                          'action'
                      },

                      el(
                          'svg',
                          {
                              class:
                              'icon',

                              width:
                              24,

                              height:
                              24,

                              'stroke-width':
                              2,

                              html:
                              '<use xlink:href="/icon-sprite.svg#external-link"></use>'
                          }
                      )
                  );

            button =
                el(
                'button',
                {
                    type:
                    'button',

                    class:
                    'open-all-links'
                }
            );

            openAllAction.append(
                button
            );

            group.prepend(
                openAllAction
            );
        }

        // Clone Harmony's button if necessary to remove its hydrated
        // Fresh listener, which contains the original unpatched URLs.
        if (
            button.dataset.hbrPatched !==
            '1'
        ) {
            const replacement =
                  button.cloneNode(
                      true
                  );

            replacement.dataset.hbrPatched =
                '1';

            button.replaceWith(
                replacement
            );

            button =
                replacement;

            button.addEventListener(
                'click',
                () => {
                    for (
                        const link
                        of recordingLinks()
                    ) {
                        window.open(
                            link.href,
                            '_blank',
                            'noopener'
                        );
                    }
                }
            );
        }

        const count =
              recordingLinks()
        .length;

        button.textContent =
            `Open all ${count} recording link${
        count === 1
            ? ''
        : 's'
    }`;

        button.title =
            `This will open ${count} tab${
        count === 1
            ? ''
        : 's'
    } (pop-up)`;
    }

    function existingHarmonyAction(candidate) {
        const wanted =
              `/${candidate.entityType}/` +
              `${candidate.mbid}/edit`;

        return $$('.action')
            .find(
            action =>
            $$('a[href]', action)
            .some(
                link => {
                    try {
                        return (
                            new URL(
                                link.href,
                                location.href
                            ).pathname ===
                            wanted
                        );
                    } catch {
                        return false;
                    }
                }
            )
        ) || null;
    }

    function existingActionEditLink(action, candidate) {
        const wanted =
              `/${candidate.entityType}/` +
              `${candidate.mbid}/edit`;

        return $$(
            'a[href]',
            action
        ).find(
            link => {
                try {
                    return (
                        new URL(
                            link.href,
                            location.href
                        ).pathname ===
                        wanted
                    );
                } catch {
                    return false;
                }
            }
        ) || null;
    }

    function appendCandidateToEditUrl(link, candidate, releaseMbid) {
        const url =
              new URL(
                  link.href,
                  location.href
              );

        const prefix =
              actionEditPrefix(
                  candidate.entityType
              );

        const indexes =
              [
                  ...url.searchParams
                  .keys()
              ]
        .map(
            key =>
            key.match(
                new RegExp(
                    `^${prefix.replace(
                        /[.*+?^${}()|[\]\\]/g,
                        '\\$&'
                    )}\\.url\\.(\\d+)\\.text$`
                )
            )
        )
        .filter(Boolean)
        .map(
            match =>
            Number(
                match[1]
            )
        );

        const existing =
              indexes.some(
                  index =>
                  beatportEntityIdentity(
                      url.searchParams.get(
                          `${prefix}.url.${index}.text`
                      )
                  ) ===
                  beatportEntityIdentity(
                      candidate.beatportUrl
                  )
              );

        if (existing) {
            return;
        }

        const index =
              indexes.length
        ? Math.max(
            ...indexes
        ) + 1
        : 0;

        url.searchParams.set(
            `${prefix}.url.${index}.text`,
            candidate.beatportUrl
        );

        url.searchParams.set(
            `${prefix}.url.${index}.link_type_id`,
            candidate.linkTypeId
        );

        if (
            !url.searchParams.has(
                `${prefix}.edit_note`
            )
        ) {
            url.searchParams.set(
                `${prefix}.edit_note`,
                `Matched ${candidate.entityType} while importing ` +
                `https://musicbrainz.org/release/${releaseMbid} with Harmony`
            );
        }

        link.href =
            url.href;
    }

    function ensureCandidateProviderIcon(action, candidate) {
        const identity =
              beatportEntityIdentity(
                  candidate.beatportUrl
              );

        if (!identity) {
            return;
        }

        if (
            $$(
                'a[href]',
                action
            ).some(
                link =>
                beatportEntityIdentity(
                    link.href
                ) ===
                identity
            )
        ) {
            return;
        }

        const entityLinks =
              $('.entity-links', action);

        if (!entityLinks) {
            return;
        }

        entityLinks.prepend(
            el(
                'a',
                {
                    href:
                    candidate.beatportUrl,

                    target:
                    '_blank',

                    rel:
                    'noopener noreferrer'
                },

                beatportIcon(
                    18,
                    1.5
                )
            )
        );
    }

    function makeReleaseAction(candidate, releaseMbid) {
        const editUrl =
              candidateEditUrl(
                  candidate,
                  releaseMbid
              );

        const entityLinks =
              el(
                  'span',
                  {
                      class:
                      'entity-links'
                  }
              );

        entityLinks.append(
            el(
                'a',
                {
                    href:
                    candidate.beatportUrl,

                    target:
                    '_blank',

                    rel:
                    'noopener noreferrer'
                },

                beatportIcon(
                    18,
                    1.5
                )
            ),

            el(
                'a',
                {
                    href:
                    `https://musicbrainz.org/` +
                    `${candidate.entityType}/` +
                    `${candidate.mbid}`,

                    target:
                    '_blank',

                    rel:
                    'noopener noreferrer'
                },

                el(
                    'span',
                    {
                        class:
                        'musicbrainz',

                        title:
                        'MusicBrainz'
                    },

                    el(
                        'svg',
                        {
                            class:
                            'icon',

                            width:
                            18,

                            height:
                            18,

                            'stroke-width':
                            1.5,

                            html:
                            '<use xlink:href="/icon-sprite.svg#brand-metabrainz"></use>'
                        }
                    )
                ),

                candidate.name
            )
        );

        const action =
              el(
                  'div',
                  {
                      class:
                      'action',

                      'data-hbr-release-action':
                      `${candidate.entityType}:${candidate.mbid}`
                  },

                  el(
                      'svg',
                      {
                          class:
                          'icon',

                          width:
                          24,

                          height:
                          24,

                          'stroke-width':
                          1.25,

                          html:
                          '<use xlink:href="/icon-sprite.svg#link"></use>'
                      }
                  ),

                  el(
                      'div',
                      {},

                      el(
                          'p',
                          {},

                          el(
                              'a',
                              {
                                  href:
                                  editUrl.href,

                                  text:
                                  'Link external IDs'
                              }
                          ),

                          ' of ',

                          entityLinks,

                          ' to MusicBrainz'
                      )
                  )
              );

        return action;
    }

    function makeReleaseIsrcAction(mbRelease, beatportRelease) {
        if (
            !beatportRelease?.tracklistComplete ||
            !Array.isArray(
                beatportRelease.tracks
            )
        ) {
            debugReleaseActions(
                'ISRC recovery skipped: Beatport Level 2 track data is not cached.'
            );

            return null;
        }

        const harmonyIsrcs =
              releaseActionsExistingIsrcs();

        if (
            harmonyIsrcs.length
        ) {
            debugReleaseActions(
                'ISRC recovery skipped: Harmony already created an ISRC submission.',
                harmonyIsrcs
            );

            return null;
        }

        const mbTracks =
              flattenMbReleaseTracks(
                  mbRelease
              );

        const beatportTracks =
              beatportRelease.tracks;

        if (
            !mbTracks.length ||
            mbTracks.length !==
            beatportTracks.length
        ) {
            debugReleaseActions(
                'ISRC recovery skipped: track counts do not match.',
                {
                    musicBrainz:
                    mbTracks.length,

                    beatport:
                    beatportTracks.length
                }
            );

            return null;
        }

        const tracks =
              [];

        let missingCount =
            0;

        for (
            let index = 0;
            index < mbTracks.length;
            index++
        ) {
            const mbTrack =
                  mbTracks[index];

            const beatportTrack =
                  beatportTracks[index];

            const beatportIsrc =
                  normalizeIsrc(
                      beatportTrack?.isrc
                  );

            const existingIsrcs =
                  (
                      mbTrack
                      ?.recording
                      ?.isrcs ||
                      []
                  )
            .map(
                normalizeIsrc
            )
            .filter(Boolean);

            const missing =
                  Boolean(
                      beatportIsrc &&
                      !existingIsrcs.includes(
                          beatportIsrc
                      )
                  );

            if (missing) {
                missingCount++;
            }

            // Keep every track position.
            //
            // MagicISRC is positional. Blank tracks must remain
            // blank rather than shifting later ISRCs forward.
            tracks.push({
                position:
                index + 1,

                recordingMbid:
                mbTrack
                ?.recording
                ?.id ||
                '',

                title:
                clean(
                    mbTrack?.title
                ),

                beatportIsrc,

                existingIsrcs,

                missing,

                // Only missing ISRCs are actually submitted.
                // Existing ones become blank parameters.
                submissionIsrc:
                missing
                ? beatportIsrc
                : ''
            });
        }

        if (!missingCount) {
            debugReleaseActions(
                'ISRC recovery skipped: all Beatport ISRCs already exist on MusicBrainz.'
            );

            return null;
        }

        return {
            type:
            'isrc',

            source:
            'Beatport',

            sourceUrl:
            beatportRelease.releaseUrl,

            releaseMbid:
            mbRelease.id,

            tracks,

            missingCount
        };
    }

    function placeReleaseAction(action, candidate) {
        const sameType =
              $$('.action')
        .filter(
            existing =>
            $$(
                'a[href]',
                existing
            ).some(
                link => {
                    try {
                        return new URL(
                            link.href,
                            location.href
                        ).pathname
                            .startsWith(
                            `/${candidate.entityType}/`
                        );
                    } catch {
                        return false;
                    }
                }
            )
        );

        const peer =
              sameType.at(-1);

        if (peer) {
            peer.after(
                action
            );

            return;
        }

        $('main')?.append(
            action
        );
    }

    function renderReleaseActionCandidate(candidate, releaseMbid) {
        let action =
            existingHarmonyAction(
                candidate
            );

        if (action) {
            const editLink =
                  existingActionEditLink(
                      action,
                      candidate
                  );

            if (editLink) {
                appendCandidateToEditUrl(
                    editLink,
                    candidate,
                    releaseMbid
                );
            }

            ensureCandidateProviderIcon(
                action,
                candidate
            );

            return;
        }

        const marker =
              `[data-hbr-release-action="${candidate.entityType}:${candidate.mbid}"]`;

        if ($(marker)) {
            return;
        }

        action =
            makeReleaseAction(
            candidate,
            releaseMbid
        );

        placeReleaseAction(
            action,
            candidate
        );
    }

    function renderReleaseIsrcAction(action) {
        if (
            !action ||
            !action.missingCount
        ) {
            return false;
        }

        // Defensive check.
        //
        // The builder already skips if Harmony supplied an ISRC
        // action, but never create a second MagicISRC action.
        if (
            $('.magic-isrc')
        ) {
            return false;
        }

        const url =
              releaseIsrcActionUrl(
                  action
              );

        const actionElement =
              el(
                  'div',
                  {
                      class:
                      'action'
                  },

                  el(
                      'svg',
                      {
                          class:
                          'icon',

                          width:
                          '24',

                          height:
                          '24',

                          'stroke-width':
                          '2'
                      },

                      el(
                          'use',
                          {
                              'xlink:href':
                              '/icon-sprite.svg#disc'
                          }
                      )
                  ),

                  el(
                      'p',
                      {},

                      el(
                          'a',
                          {
                              class:
                              'magic-isrc',

                              href:
                              url.href,

                              text:
                              'Open with MagicISRC'
                          }
                      ),

                      ': Submit ISRCs from ',

                      el(
                          'a',
                          {
                              href:
                              action.sourceUrl,

                              target:
                              '_blank',

                              rel:
                              'noopener noreferrer',

                              text:
                              'Beatport'
                          }
                      ),

                      ' to MusicBrainz'
                  )
              );

        const firstCover =
              $('.cover-image');

        if (firstCover) {
            firstCover.before(
                actionElement
            );
        } else {
            $('main')?.append(
                actionElement
            );
        }

        debugReleaseActions(
            'Rendered Beatport MagicISRC action.',
            action
        );

        return true;
    }

    function beatportFailureMessage() {
        return $$('.message.error')
            .find(
            message => {
                const provider =
                      clean(
                          $('.provider', message)
                          ?.textContent
                      )
                .replace(
                    /:$/,
                    ''
                )
                .trim();

                return (
                    provider.toLowerCase() ===
                    'beatport'
                );
            }
        ) || null;
    }

    function releaseActionsBeatportId(beatportMessage) {
        if (!beatportMessage) {
            return '';
        }

        // Release Actions only belongs to HBR when Harmony itself
        // attempted an exact Beatport release lookup and failed.
        //
        // The native failure message contains the exact Beatport
        // release URL, which supplies the canonical release ID.

        // kellnerd pls dont break
        for (
            const link
            of $$(
                'a[href]',
                beatportMessage
            )
        ) {
            const releaseId =
                  beatportReleaseIdFromUrl(
                      link.href
                  );

            if (releaseId) {
                return releaseId;
            }
        }

        return '';
    }

    function releaseIsrcActionUrl(action) {
        const url =
              new URL(
                  'https://magicisrc.kepstin.ca'
              );

        for (
            const track
            of action.tracks
        ) {
            url.searchParams.set(
                `isrc${track.position}`,
                track.submissionIsrc
            );
        }

        url.searchParams.set(
            'musicbrainzid',
            action.releaseMbid
        );

        url.searchParams.set(
            'edit-note',
            `Import ISRCs from ${action.sourceUrl} to ` +
            `https://musicbrainz.org/release/${action.releaseMbid} ` +
            HBR_EDIT_NOTE_SUFFIX
        );

        return url;
    }

    function setReleaseActionsStatus(message,
                                      {
        state = 'info',
        title = 'Beatport Recovery',
        text = '',
        details = []
    } = {}
                                     ) {
        if (!message) {
            return;
        }

        message.classList.remove(
            'error',
            'warning',
            'info',
            'success'
        );

        message.style.borderColor = '';
        message.style.backgroundColor = '';
        message.style.color = '';

        if (state === 'success') {
            message.classList.add(
                'info'
            );

            message.style.borderColor =
                '#4CAF50';

            message.style.backgroundColor =
                '#e8f5e9';

            message.style.color =
                '#1b5e20';
        } else {
            message.classList.add(
                state
            );

            message.style.borderColor =
                '';

            message.style.backgroundColor =
                '';
        }
        const content =
              messageContent(
                  message
              );

        if (!content) {
            return;
        }

        const body =
              el(
                  'div'
              );

        body.append(
            el(
                'p',
                {},
                el(
                    'strong',
                    {
                        text:
                        `${title}: `
                    }
                ),
                text
            )
        );

        for (
            const detail
            of details
        ) {
            if (!detail) {
                continue;
            }

            body.append(
                el(
                    'p',
                    {
                        text:
                        detail
                    }
                )
            );
        }

        content.replaceChildren(
            ...body.childNodes
        );
    }

    function musicBrainzErrorDescription(error) {
        const status =
              Number(
                  error?.status
              );

        if (status === 429) {
            return (
                'MusicBrainz rate limited the request.'
            );
        }

        if (
            [
                502,
                503,
                504
            ].includes(
                status
            )
        ) {
            return (
                `MusicBrainz returned ${status} and appears to be temporarily unavailable.`
            );
        }

        if (status) {
            return (
                `MusicBrainz returned HTTP ${status}.`
            );
        }

        return (
            'The MusicBrainz request failed.'
        );
    }

    function appendReleaseActionsRetryButton(message, text, onClick) {
        const content =
              messageContent(
                  message
              );

        if (!content) {
            return;
        }

        $('#hbr-release-actions-retry')
            ?.remove();

        const button =
              el(
                  'button',
                  {
                      id:
                      'hbr-release-actions-retry',

                      type:
                      'button',

                      text,

                      style: {
                          marginTop:
                          '8px',

                          padding:
                          '6px 12px',

                          border:
                          '1px solid #777',

                          borderRadius:
                          '4px',

                          cursor:
                          'pointer',

                          fontSize:
                          '0.9em',

                          fontWeight:
                          'bold'
                      }
                  }
              );

        button.addEventListener(
            'click',

            async () => {
                button.disabled =
                    true;

                button.textContent =
                    'Retrying…';

                try {
                    await onClick();
                } catch (error) {
                    console.warn(
                        '[Harmony Beatport Recovery] MusicBrainz retry failed.',
                        error
                    );

                    button.disabled =
                        false;

                    button.textContent =
                        text;
                }
            }
        );

        content.append(
            button
        );
    }

    async function retryFailedReleaseActionLookups(beatportMessage, releaseMbid, beatportReleaseId, candidates, failedTypes, totals) {
        const types =
              [
                  ...new Set(
                      failedTypes
                  )
              ]
        .filter(
            type =>
            [
                'artist',
                'label',
                'recording'
            ].includes(
                type
            )
        );

        if (!types.length) {
            return;
        }

        const retryCandidateCount =
              candidates.filter(
                  candidate =>
                  types.includes(
                      candidate.entityType
                  )
              ).length;

        const baseUnverifiable =
              totals.baseUnverifiable ??
              Math.max(
                  0,
                  totals.unverifiable -
                  retryCandidateCount
              );

        setReleaseActionsStatus(
            beatportMessage,
            {
                state:
                'info',

                text:
                `Retrying failed MusicBrainz lookup${
                types.length === 1
                ? ''
                : 's'
            }: ${types.join(', ')}…`
            }
        );

        const results =
              {};

        // Keep these sequential so we continue respecting the
        // MusicBrainz request spacing already enforced by
        // musicBrainzJson().
        for (
            const type
            of types
        ) {
            results[type] =
                await fetchMbReleaseEntitiesSafe(
                type,
                releaseMbid,
                'url-rels'
            );
        }

        const remainingFailures =
              [];

        let rendered =
            0;

        let alreadyPresent =
            0;

        let unverifiable =
            0;

        for (
            const type
            of types
        ) {
            const result =
                  results[type];

            if (!result?.ok) {
                remainingFailures.push(
                    type
                );

                continue;
            }

            const cache =
                  entityCacheMap(
                      result.entities
                  );

            const matchingCandidates =
                  candidates.filter(
                      candidate =>
                      candidate.entityType ===
                      type
                  );

            for (
                const candidate
                of matchingCandidates
            ) {
                const mbEntity =
                      cache.get(
                          candidate.mbid
                      );

                if (!mbEntity) {
                    unverifiable++;

                    console.warn(
                        '[Harmony Beatport Recovery] Retried MusicBrainz entity was not returned by browse API.',
                        candidate
                    );

                    continue;
                }

                if (
                    alreadyHasBeatportUrl(
                        mbEntity,
                        candidate.beatportUrl
                    )
                ) {
                    alreadyPresent++;

                    continue;
                }

                renderReleaseActionCandidate(
                    candidate,
                    releaseMbid
                );

                rendered++;
            }
        }

        const totalRendered =
              totals.rendered +
              rendered;

        const totalAlreadyPresent =
              totals.alreadyPresent +
              alreadyPresent;

        const failedCandidateCount =
              candidates.filter(
                  candidate =>
                  remainingFailures.includes(
                      candidate.entityType
                  )
              ).length;

        const totalUnverifiable =
              baseUnverifiable +
              unverifiable +
              failedCandidateCount;

        const nextTotals = {
            rendered:
            totalRendered,

            alreadyPresent:
            totalAlreadyPresent,

            unverifiable:
            totalUnverifiable,

            baseUnverifiable
        };

        if (
            remainingFailures.length
        ) {
            const errors =
                  remainingFailures.map(
                      type =>
                      `${type}: ${musicBrainzErrorDescription(
                          results[type]?.error
                      )}`
                  );

            setReleaseActionsStatus(
                beatportMessage,
                {
                    state:
                    'warning',

                    text:
                    `MusicBrainz retry completed partially for release ${beatportReleaseId}.`,

                    details: [
                        `Still failing: ${remainingFailures.join(', ')}.`,
                        ...errors,
                        `${totalRendered} Beatport action(s) added.`,
                        `${totalAlreadyPresent} relationship(s) already existed.`,
                        `${totalUnverifiable} candidate(s) could not be verified.`
                    ]
                }
            );

            appendReleaseActionsRetryButton(
                beatportMessage,

                `Retry ${remainingFailures.join(', ')}`,

                () =>
                retryFailedReleaseActionLookups(
                    beatportMessage,
                    releaseMbid,
                    beatportReleaseId,
                    candidates,
                    remainingFailures,
                    nextTotals
                )
            );

            return;
        }

        setReleaseActionsStatus(
            beatportMessage,
            {
                state:
                'success',

                text:
                `Beatport Recovery completed for release ${beatportReleaseId}.`,

                details: [
                    `${totalRendered} Beatport action(s) added.`,
                    `${totalAlreadyPresent} relationship(s) already existed.`,
                    `${totalUnverifiable} candidate(s) could not be verified.`
                ]
            }
        );
    }

    function startReleaseActionsTrackLookup(beatportMessage, beatportReleaseId, beatportRelease) {
        const target =
              new URL(
                  beatportRelease?.releaseUrl ||
                  `https://www.beatport.com/release/-/${beatportReleaseId}`
              );

        const id =
              requestId();

        target.searchParams.set(
            'hbr_resolve',
            id
        );

        target.searchParams.set(
            'hbr_release',
            String(
                beatportReleaseId
            )
        );

        target.searchParams.set(
            'hbr_resolve_mode',
            'tracks'
        );

        autoStartedFor =
            `release:${beatportReleaseId}:tracks`;

        setReleaseActionsStatus(
            beatportMessage,
            {
                state:
                'info',

                text:
                `Opening Beatport release ${beatportReleaseId} to retrieve full track data…`
            }
        );

        openBeatport(
            target.toString()
        );

        return true;
    }

    async function maybeAutoReleaseActionsLookup(beatportMessage, beatportReleaseId, beatportRelease) {
        if (
            !settings.auto
        ) {
            return;
        }

        const key =
              `release:${beatportReleaseId}:tracks`;

        if (
            autoStartedFor ===
            key
        ) {
            return;
        }

        startReleaseActionsTrackLookup(
            beatportMessage,
            beatportReleaseId,
            beatportRelease
        );
    }

    function ensureReleaseActionsRecoveryControls(beatportMessage, beatportReleaseId, beatportRelease) {
        const content =
              messageContent(
                  beatportMessage
              );

        if (!content) {
            return;
        }

        if (
            !$('#' + IDS.settings)
        ) {
            content.append(
                settingsPanel({
                    showTrackData:
                    false,

                    onAuto:
                    () =>
                    maybeAutoReleaseActionsLookup(
                        beatportMessage,
                        beatportReleaseId,
                        beatportRelease
                    )
                })
            );
        }

        if (
            !$('#' + IDS.button)
        ) {
            content.append(
                recoveryButton({
                    text:
                    'Retrieve track data',

                    onClick:
                    () =>
                    startReleaseActionsTrackLookup(
                        beatportMessage,
                        beatportReleaseId,
                        beatportRelease
                    )
                })
            );
        }
    }

    function queueReleaseActions(beatportMessage, beatportReleaseId) {
        releaseActionsQueue =
            releaseActionsQueue
            .then(
            () =>
            processReleaseActions(
                beatportMessage,
                beatportReleaseId
            )
        )
            .catch(
            error =>
            console.warn(
                '[Harmony Beatport Recovery] Release Actions processing failed.',
                error
            )
        );
    }

    async function processReleaseActions(beatportMessage, beatportReleaseId) {
        debugReleaseActions(
            'Processing Release Actions.',
            {
                url:
                location.href,

                beatportReleaseId
            }
        );

        setReleaseActionsStatus(
            beatportMessage,
            {
                state:
                'info',

                text:
                `Beatport release ${beatportReleaseId} detected. Loading cached Beatport data…`
            }
        );

        const releaseMbid =
              releaseActionsMbid();

        debugReleaseActions(
            'Release MBID:',
            releaseMbid
        );

        if (!releaseMbid) {
            setReleaseActionsStatus(
                beatportMessage,
                {
                    state:
                    'error',

                    text:
                    'Could not determine the MusicBrainz release MBID.'
                }
            );

            return;
        }

        // Beatport identity comes from the exact Beatport release URL
        // carried through Harmony's url= state.
        const cachedRecord =
              await getCachedRelease(
                  beatportReleaseId
              );

        debugReleaseActions(
            'Beatport cache record:',
            cachedRecord
        );

        if (
            !cachedRecord?.release
        ) {
            setReleaseActionsStatus(
                beatportMessage,
                {
                    state:
                    'warning',

                    text:
                    `Beatport release ${beatportReleaseId} is not available in the HBR cache.`,

                    details: [
                        'Retrieve the exact Beatport release to recover its metadata.'
                    ]
                }
            );

            ensureReleaseActionsRecoveryControls(
                beatportMessage,
                beatportReleaseId,
                null
            );

            await maybeAutoReleaseActionsLookup(
                beatportMessage,
                beatportReleaseId,
                null
            );

            return;
        }

        const beatportRelease =
              cachedRecord.release;

        const hasTrackData =
              Boolean(
                  beatportRelease
                  .tracklistComplete &&
                  Array.isArray(
                      beatportRelease.tracks
                  )
              );

        debugReleaseActions(
            'Beatport metadata level:',
            hasTrackData
            ? 'Level 2 — complete track data'
            : 'Level 1 — release metadata only'
        );

        // Restore Beatport to the provider list @ top of page
        ensureProvider(
            beatportRelease
        );

        setReleaseActionsStatus(
            beatportMessage,
            {
                state:
                'info',

                text:
                `Cached Beatport release ${beatportReleaseId} found. Loading MusicBrainz release structure…`
            }
        );

        let mbRelease;

        try {
            mbRelease =
                await fetchMbReleaseStructure(
                releaseMbid
            );
        } catch (error) {
            console.warn(
                '[Harmony Beatport Recovery] Could not load MusicBrainz release structure.',
                error
            );

            debugReleaseActions(
                'MusicBrainz release lookup failed.',
                error
            );

            setReleaseActionsStatus(
                beatportMessage,
                {
                    state:
                    'error',

                    text:
                    musicBrainzErrorDescription(
                        error
                    ),

                    details: [
                        'Beatport Recovery could not load the MusicBrainz release structure.'
                    ]
                }
            );

            appendReleaseActionsRetryButton(
                beatportMessage,
                'Retry MusicBrainz lookup',

                () => {
                    queueReleaseActions(
                        beatportMessage,
                        beatportReleaseId
                    );
                }
            );

            return;
        }

        debugReleaseActions(
            'MusicBrainz release structure received.',
            mbRelease
        );

        const candidates =
              makeReleaseActionCandidates(
                  mbRelease,
                  beatportRelease
              );

        const isrcAction =
              makeReleaseIsrcAction(
                  mbRelease,
                  beatportRelease
              );

        debugReleaseActions(
            'Generated ISRC action:',
            isrcAction
        );

        debugReleaseActions(
            'Generated candidates:',
            candidates
        );

        if (!candidates.length) {
            setReleaseActionsStatus(
                beatportMessage,
                {
                    state:
                    'warning',

                    text:
                    'Beatport data was found, but no safe MusicBrainz entity matches could be generated.'
                }
            );

            if (
                !hasTrackData
            ) {
                ensureReleaseActionsRecoveryControls(
                    beatportMessage,
                    beatportReleaseId,
                    beatportRelease
                );

                await maybeAutoReleaseActionsLookup(
                    beatportMessage,
                    beatportReleaseId,
                    beatportRelease
                );
            }

            return;
        }

        const artistCandidates =
              candidates.filter(
                  candidate =>
                  candidate.entityType ===
                  'artist'
              );

        const labelCandidates =
              candidates.filter(
                  candidate =>
                  candidate.entityType ===
                  'label'
              );

        const recordingCandidates =
              candidates.filter(
                  candidate =>
                  candidate.entityType ===
                  'recording'
              );

        debugReleaseActions(
            'Candidate counts:',
            {
                artists:
                artistCandidates.length,

                labels:
                labelCandidates.length,

                recordings:
                recordingCandidates.length
            }
        );

        setReleaseActionsStatus(
            beatportMessage,
            {
                state:
                'info',

                text:
                'Checking existing MusicBrainz external links…',

                details: [
                    `${artistCandidates.length} artist candidate(s), ` +
                    `${labelCandidates.length} label candidate(s), ` +
                    `${recordingCandidates.length} recording candidate(s).`,

                    hasTrackData
                    ? 'Full Beatport track metadata is cached.'
                    : 'Beatport track metadata is not cached; recording links and ISRCs will not be checked.'
                ]
            }
        );

        const artistResult =
              artistCandidates.length
        ? await fetchMbReleaseEntitiesSafe(
            'artist',
            releaseMbid,
            'url-rels'
        )
        : {
            ok: true,
            entities: [],
            error: null
        };

        debugReleaseActions(
            'MusicBrainz artist browse result:',
            artistResult
        );

        const labelResult =
              labelCandidates.length
        ? await fetchMbReleaseEntitiesSafe(
            'label',
            releaseMbid,
            'url-rels'
        )
        : {
            ok: true,
            entities: [],
            error: null
        };

        debugReleaseActions(
            'MusicBrainz label browse result:',
            labelResult
        );

        const recordingResult =
              recordingCandidates.length
        ? await fetchMbReleaseEntitiesSafe(
            'recording',
            releaseMbid,
            'url-rels'
        )
        : {
            ok: true,
            entities: [],
            error: null
        };

        debugReleaseActions(
            'MusicBrainz recording browse result:',
            recordingResult
        );

        const failedLookups =
              [
                  ['artist', artistResult],
                  ['label', labelResult],
                  ['recording', recordingResult]
              ]
        .filter(
            ([, result]) =>
            !result.ok
        );

        const artistCache =
              entityCacheMap(
                  artistResult.entities
              );

        const labelCache =
              entityCacheMap(
                  labelResult.entities
              );

        const recordingCache =
              entityCacheMap(
                  recordingResult.entities
              );

        let rendered = 0;
        let alreadyPresent = 0;
        let unverifiable = 0;

        for (
            const candidate
            of candidates
        ) {
            debugReleaseActions(
                'Processing candidate:',
                candidate
            );

            const result = {
                artist:
                artistResult,

                label:
                labelResult,

                recording:
                recordingResult
            }[
                candidate.entityType
            ];

            // If the browse request for this entity type failed,
            // we cannot safely know whether its Beatport link
            // already exists.
            if (
                !result.ok
            ) {
                unverifiable++;

                debugReleaseActions(
                    'Candidate skipped because its MusicBrainz relationship lookup failed.',
                    candidate
                );

                continue;
            }

            const cache = {
                artist:
                artistCache,

                label:
                labelCache,

                recording:
                recordingCache
            }[
                candidate.entityType
            ];

            const mbEntity =
                  cache.get(
                      candidate.mbid
                  );

            if (!mbEntity) {
                unverifiable++;

                console.warn(
                    '[Harmony Beatport Recovery] Release Actions entity was not returned by MusicBrainz browse API.',
                    candidate
                );

                continue;
            }

            const exists =
                  alreadyHasBeatportUrl(
                      mbEntity,
                      candidate.beatportUrl
                  );

            debugReleaseActions(
                'Existing Beatport relationship check:',
                {
                    entityType:
                    candidate.entityType,

                    mbid:
                    candidate.mbid,

                    beatportUrl:
                    candidate.beatportUrl,

                    alreadyExists:
                    exists,

                    existingUrls:
                    mbEntityRelations(
                        mbEntity
                    )
                }
            );

            if (
                exists
            ) {
                alreadyPresent++;

                continue;
            }

            renderReleaseActionCandidate(
                candidate,
                releaseMbid
            );

            rendered++;
        }
        const isrcRendered =
              renderReleaseIsrcAction(
                  isrcAction
              );

        ensureOpenAllRecordingLinksButton();

        // Use HBR's Beatport message as the permanent
        // Release Actions status display.
        if (
            failedLookups.length
        ) {
            const failedTypes =
                  failedLookups
            .map(
                ([type]) =>
                type
            )
            .join(', ');

            const serverErrors =
                  failedLookups
            .map(
                ([type, result]) =>
                `${type}: ${musicBrainzErrorDescription(
                    result.error
                )}`
            );

            setReleaseActionsStatus(
                beatportMessage,
                {
                    state:
                    'warning',

                    text:
                    `Beatport Recovery completed partially for release ${beatportReleaseId}.`,

                    details: [
                        `MusicBrainz lookup failure(s): ${failedTypes}.`,
                        ...serverErrors,
                        `${rendered} Beatport action(s) added.`,
                        `${alreadyPresent} relationship(s) already existed.`,
                        `${unverifiable} candidate(s) could not be verified.`,

                        hasTrackData
                        ? 'Full Beatport track metadata was available.'
                        : 'Beatport track metadata was not cached; recording links and ISRCs were not checked.',
                    ]
                }
            );

            appendReleaseActionsRetryButton(
                beatportMessage,

                `Retry ${failedLookups
                .map(
                    ([type]) =>
                    type
                )
                .join(', ')}`,

                () =>
                retryFailedReleaseActionLookups(
                    beatportMessage,
                    releaseMbid,
                    beatportReleaseId,
                    candidates,

                    failedLookups.map(
                        ([type]) =>
                        type
                    ),

                    {
                        rendered,
                        alreadyPresent,
                        unverifiable
                    }
                )
            );

        } else {
            setReleaseActionsStatus(
                beatportMessage,
                {
                    state:
                    'success',

                    text:
                    `Beatport Recovery completed for release ${beatportReleaseId}.`,

                    details: [
                        `${rendered} Beatport action(s) added.`,
                        `${alreadyPresent} relationship(s) already existed.`,

                        unverifiable
                        ? `${unverifiable} candidate(s) could not be verified.`
                        : 'All available candidates were checked successfully.',

                        hasTrackData
                        ? 'Artist, label and recording links were checked using full Beatport track metadata.'
                        : 'Only release-level metadata was cached. Artist and label links were checked; recording links and ISRCs were skipped.'
                    ]
                }
            );
        }
        if (
            !hasTrackData
        ) {
            ensureReleaseActionsRecoveryControls(
                beatportMessage,
                beatportReleaseId,
                beatportRelease
            );

            await maybeAutoReleaseActionsLookup(
                beatportMessage,
                beatportReleaseId,
                beatportRelease
            );
        }
        console.info(
            '[Harmony Beatport Recovery] Release Actions processed.',
            {
                releaseMbid,

                beatportReleaseId,

                candidates:
                candidates.length,

                rendered,

                alreadyPresent,

                unverifiable,

                failedLookups:
                failedLookups.map(
                    ([type, result]) => ({
                        type,

                        status:
                        result.error?.status ||
                        null
                    })
                )
            }
        );
    }

    async function initReleaseActions() {
        if (
            releaseActionsStarted
        ) {
            return;
        }

        // Harmony's native Beatport failure is the trigger and
        // authoritative source of the exact Beatport release ID.
        const nativeBeatportFailure =
              beatportFailureMessage();

        if (!nativeBeatportFailure) {
            debugReleaseActions(
                'Release Actions inactive: no native Beatport failure message.'
            );

            return;
        }

        const beatportReleaseId =
              releaseActionsBeatportId(
                  nativeBeatportFailure
              );

        if (!beatportReleaseId) {
            debugReleaseActions(
                'Release Actions inactive: Beatport failure did not expose a release ID.'
            );

            return;
        }

        // We have consumed everything HBR needs from Harmony's
        // failure. Hide it and use HBR's own message from here on.
        suppressBeatportFailureMessage(
            nativeBeatportFailure
        );

        const beatportMessage =
              ensureBeatportMessage();

        if (!beatportMessage) {
            return;
        }

        releaseActionsStarted =
            true;

        await loadSettings();

        debugReleaseActions(
            'Release Actions activated.',
            {
                beatportReleaseId
            }
        );

        releaseActionsReleaseListener =
            GM_addValueChangeListener(
            cacheKey(
                beatportReleaseId
            ),

            () =>
            queueReleaseActions(
                beatportMessage,
                beatportReleaseId
            )
        );

        queueReleaseActions(
            beatportMessage,
            beatportReleaseId
        );
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

        // Release Actions is a separate downstream workflow and is
        // not part of the provider lookup handshake.
        if (
            isHarmonyReleaseActions()
        ) {
            initReleaseActions();

            return;
        }

        // If HBR itself caused the previous automatic Harmony
        // navigation/reload, consume that busy state now.
        //
        // This releases the next provider in the chain while also
        // suppressing another automatic HBR lookup on this load.
        suppressHbrLookupThisLoad =
            consumeHbrReturnLoad();

        if (
            !suppressHbrLookupThisLoad
        ) {
            setHbrFlowStatus(
                'waiting'
            );
        }

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

        return mergeRelease(
            existing,
            incoming,
            LEVEL.RELEASE,
            LEVEL.RELEASE
        );
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

                // Existing Level-1 release recognition.
                const release =
                      normalizeBeatportRelease(
                          value
                      );

                if (release?.releaseId) {
                    rememberRelease(
                        release
                    );
                }

                // Embedded rich track query recognition.
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

        // Network responses from /catalog/tracks do not contain the
        // React Query wrapper, so recognize those using their URL.
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

                orderedTrackIds:
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

    function beatportDomTrackOrder(releaseId) {
        if (
            String(
                currentBeatportReleaseId()
            ) !==
            String(
                releaseId
            )
        ) {
            return [];
        }

        const tracks =
              [];

        const seen =
              new Set();

        // Beatport has two responsive tracklist renderers:
        //
        //   tile/card view:
        //     [data-testid="tracks-list-item"]
        //
        //   table/list view:
        //     [data-testid="tracks-table-row"]
        //
        // Both preserve the authoritative visible release order and
        // both contain the canonical /track/<slug>/<id> link.
        const rows =
              $$(
                  [
                      '[data-testid="tracks-list-item"]',
                      '[data-testid="tracks-table-row"]'
                  ].join(',')
              );

        for (
            const row
            of rows
        ) {
            const trackLink =
                  $('a[href*="/track/"]', row);

            if (!trackLink) {
                continue;
            }

            const href =
                  trackLink.getAttribute(
                      'href'
                  ) ||
                  '';

            const match =
                  href.match(
                      /\/track\/[^/]+\/(\d+)/
                  );

            if (!match) {
                continue;
            }

            const id =
                  Number(
                      match[1]
                  );

            if (
                !Number.isFinite(id) ||
                seen.has(id)
            ) {
                continue;
            }

            seen.add(id);

            tracks.push({
                id,

                number:
                tracks.length + 1,

                title:
                clean(
                    trackLink.getAttribute(
                        'title'
                    ) ||
                    trackLink.textContent
                ) ||
                null
            });
        }

        return tracks;
    }

    function setupBeatportDomTrackOrderWatch() {
        const releaseId =
              currentBeatportReleaseId();

        if (!releaseId) {
            return;
        }

        const assembly =
              assemblyForRelease(
                  releaseId
              );

        let running =
            false;

        const capture =
              async () => {
                  if (
                      running ||
                      assembly.level2Complete
                  ) {
                      return;
                  }

                  running =
                      true;

                  try {
                      const orderedTracks =
                            beatportDomTrackOrder(
                                releaseId
                            );

                      if (!orderedTracks.length) {
                          return;
                      }

                      const expectedCount =
                            Number(
                                assembly.release
                                ?.trackCount
                            );

                   // If release metadata already tells us the expected
                   // size, do not save a partially rendered DOM list.
                      if (
                          Number.isFinite(
                              expectedCount
                          ) &&
                          expectedCount > 0 &&
                          orderedTracks.length !==
                          expectedCount
                      ) {
                          return;
                      }

                      const orderedTrackIds =
                            orderedTracks.map(
                                track =>
                                track.id
                            );

                      const unchanged =
                            orderedTrackIds.length ===
                            assembly.orderedTrackIds.length &&
                            orderedTrackIds.every(
                                (id, index) =>
                                id ===
                                assembly.orderedTrackIds[index]
                            );

                      if (!unchanged) {
                          assembly.orderedTrackIds =
                              orderedTrackIds;

                          if (
                              DEBUG_FOUND_RELEASES
                          ) {
                              console.debug(
                                  '[Harmony Beatport Recovery] ' +
                                  'Captured Beatport DOM track order.',
                                  {
                                      releaseId,
                                      orderedTrackIds
                                  }
                              );
                          }
                      }

                      await tryAssembleLevel2(
                          releaseId
                      );

                      if (
                          assembly.level2Complete
                      ) {
                          observer.disconnect();
                      }
                  } catch (error) {
                      console.warn(
                          '[Harmony Beatport Recovery] ' +
                          'Could not capture Beatport track order.',
                          error
                      );
                  } finally {
                      running =
                          false;
                  }
              };

        const observer =
              new MutationObserver(
                  () => {
                      capture();
                  }
              );

        observer.observe(
            document.body,
            {
                childList:
                true,

                subtree:
                true
            }
        );

     // The tracklist may already be rendered before the observer
     // is installed.
        capture();
    }

    function buildLevel2Release(release, richTracks, orderedTrackIds) {
        if (
            !release?.releaseId ||
            !Array.isArray(
                richTracks
            ) ||
            !richTracks.length ||
            !Array.isArray(
                orderedTrackIds
            ) ||
            !orderedTrackIds.length
        ) {
            return null;
        }

        const expectedCount =
              Number(
                  release.trackCount
              );

        if (
            Number.isFinite(
                expectedCount
            ) &&
            expectedCount > 0
        ) {
            if (
                orderedTrackIds.length !==
                expectedCount
            ) {
                return null;
            }

            if (
                richTracks.length <
                expectedCount
            ) {
                return null;
            }
        }

        const tracksById =
              new Map();

        for (
            const track
            of richTracks
        ) {
            const id =
                  Number(
                      track?.id
                  );

            if (
                Number.isFinite(id)
            ) {
                tracksById.set(
                    id,
                    track
                );
            }
        }

        const tracks =
              [];

        for (
            let index = 0;
            index <
            orderedTrackIds.length;
            index++
        ) {
            const id =
                  Number(
                      orderedTrackIds[index]
                  );

            const track =
                  tracksById.get(
                      id
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

     // Level 2 consists of three independently discovered pieces:
     //
     //   release metadata
     //   rich track metadata
     //   rendered Beatport track order
     //
     // Arrival order does not matter.
        if (
            !assembly.release ||
            !assembly.richTracks.length ||
            !assembly.orderedTrackIds.length
        ) {
            return null;
        }

        const level2 =
              buildLevel2Release(
                  assembly.release,
                  assembly.richTracks,
                  assembly.orderedTrackIds
              );

        if (!level2) {
            return null;
        }

        const record =
              await cacheRelease(
                  level2,
                  LEVEL.TRACKS
              );

        if (
            recordLevel(
                record
            ) >=
            LEVEL.TRACKS
        ) {
            assembly.level2Complete =
                true;

            if (
                DEBUG_CACHED_RELEASES
            ) {
                console.debug(
                    '[Harmony Beatport Recovery] ' +
                    'Beatport release upgraded to Level 2.',
                    {
                        releaseId:
                        String(
                            releaseId
                        ),

                        tracks:
                        level2.tracks.length,

                        isrcs:
                        level2.tracks.filter(
                            track =>
                            clean(
                                track.isrc
                            )
                        ).length
                    }
                );
            }
        }

        return record;
    }

    async function ingestBeatportDataNow(data, sourceUrl = '', source = 'network') {

        // A single payload can contain the same release more than once.
        // Deduplicate/merge it before touching storage.
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

        // First feed all discovered pieces into the in-memory assembler.
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

        // Every recognized release still enters the normal Level-1
        // cache exactly as before.
        if (releases.size) {
            await cacheReleaseBatch(
                [...releases.values()],
                LEVEL.RELEASE
            );
        }

        // Any touched release may now have both halves required
        // for Level 2.
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
                    'hbr_release',
                    'hbr_resolve_mode'
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
            // Cosmetic only.
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

        const mode =
              clean(
                  url.searchParams.get(
                      'hbr_resolve_mode'
                  )
              ) === 'tracks'
        ? 'tracks'
        : 'upc';

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

                mode,

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

        // Preserve the resolver across a Beatport same-tab reload.
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
                    ),

                    mode:
                    stored.mode === 'tracks'
                    ? 'tracks'
                    : 'upc'
                };
            }
        } catch {
            // Ignore invalid session data.
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
            (
            session.mode === 'tracks'
            ? `retrieving full track data for release ${session.releaseId}…`
            : `waiting for UPC from release ${session.releaseId}…`
        );
    }

    async function refreshBeatportUrlResolver() {
        const session =
              urlResolverSession;

        if (!session) {
            return false;
        }

        // The universal Beatport scraper owns this record.
        // This helper only watches it.
        const record =
              await getCachedRelease(
                  session.releaseId
              );

        if (
            urlResolverSession !==
            session
        ) {
            return false;
        }

        //
        // RELEASE ACTIONS MODE
        //
        // The exact release is already known. Wait until the universal
        // scraper upgrades it to Level 2.
        //
        // Harmony Release Actions independently watches this exact
        // cache key, so no response event is necessary.
        //
        if (
            session.mode ===
            'tracks'
        ) {
            if (
                recordLevel(
                    record
                ) < LEVEL.TRACKS
            ) {
                return false;
            }

            console.debug(
                '[Harmony Beatport Recovery] ' +
                'Exact-release helper reached Level 2.',
                {
                    releaseId:
                    session.releaseId
                }
            );

            clearBeatportUrlResolverSession();

            stripUrlResolverParams();

            window.close();

            return true;
        }
        //
        // URL -> UPC MODE
        //
        if (
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

        // The embedded scraper may already have populated the record
        // before this listener is installed, so we both listen AND
        // perform an immediate read below.
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

        // The first Harmony-created URL seeds a session local to this
        // Beatport tab. sessionStorage then follows the user through
        // subsequent Beatport navigation even though ?hbr disappears.
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

            // The query parameters are only bootstrap information.
            // Removing them means manual browsing produces ordinary
            // Beatport URLs while the helper survives in sessionStorage.
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
            async () => {
                const session =
                      helperSession;

                if (!session) {
                    window.close();
                    return;
                }

                // Tell the Harmony tab that this is an intentional skip
                // before closing the helper.
                await GM_setValue(
                    helperResultKey(
                        session.requestId
                    ),
                    {
                        requestId:
                        session.requestId,

                        state:
                        'skipped',

                        timestamp:
                        Date.now()
                    }
                );

                stopBeatportHelperWatch();
                clearBeatportHelperSession();
                stripHelperUrlParams();

                window.close();
            }
        );

        panel.append(cancel);

        document.body.append(panel);
    }

    async function finishBeatportHelper(session,record) {
        // Mark this as a successful script-driven close before closing.
        // The Harmony-side tab onclose handler uses this to distinguish
        // success from a manual close.
        await GM_setValue(
            helperResultKey(
                session.requestId
            ),
            {
                requestId:
                session.requestId,

                state:
                'success',

                releaseId:
                String(
                    record.release.releaseId
                ),

                level:
                recordLevel(
                    record
                ),

                timestamp:
                Date.now()
            }
        );

        stopBeatportHelperWatch();
        clearBeatportHelperSession();
        stripHelperUrlParams();

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

        // The helper may have been cancelled while awaiting storage.
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

        // The user can search, open an artist/label page, change the
        // search terms, etc. The universal Beatport scraper keeps doing
        // its normal work and this listener waits for the UPC pointer.
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

        // Desired cache level reached. There is no event back to Harmony:
        // Harmony is independently watching this same cache record.
        if (
            recordLevel(record) >=
            session.targetLevel
        ) {
            await finishBeatportHelper(
                session,
                record
            );

            return;
        }

        // Level 1 identifies the exact Beatport release. If Level 2 was
        // requested, navigate to it. The universal scraper—not this
        // helper—will ingest the full release/track JSON and upgrade it.
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

        // Do an initial read as well as listening for future changes.
        // This handles a UPC that the universal scraper cached before
        // the helper listener finished initializing.
        await refreshBeatportHelper();
    }

    // =========================================================================
    // Beatport entry
    // =========================================================================

    async function processBeatport() {
        await ingestEmbeddedBeatportData();

     // Rich JSON may be available before React has rendered the
     // release track rows. The DOM supplies authoritative track
     // ordering, so retry Level-2 assembly when those rows appear.
        setupBeatportDomTrackOrderWatch();

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
        if (isHarmonySettings()) {
            initHarmonySettings();
        } else if (isHarmony()) {
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
