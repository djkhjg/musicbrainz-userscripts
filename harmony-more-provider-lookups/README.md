# Harmony: More Provider Lookups (MPL)

A userscript that adds provider searches, release comparisons and extra MusicBrainz Release Actions to Harmony.

## Usage

Install [harmony-more-provider-lookups.user.js](harmony-more-provider-lookups.user.js) in your userscript manager. On Harmony, enable the providers you want and run a release lookup.

MPL supports **Bandcamp, SoundCloud, Traxsource, YouTube Music and 7digital**. It checks its cache before requesting provider data. Background searches continue sequentially while you review results in the comparison panel.

- Choose **Use this release** to accept a candidate, or skip the provider. Use manual search when a background lookup needs help or website interaction.
- Native provider results such as Bandcamp are combined into a Harmony re-lookup. Other providers then add their data to the release.
- Passive browsing of provider pages collects and caches observations independently. The consts `CACHE_MAX_ENTRIES`, `CACHE_BLOCK_SIZE`, and `CACHE_LEVEL2_BLOCKS` can be adjusted to change the size of the saved cache. Cache only stores text and URLs, no images.
- Comparison colours distinguish matching values (green), normalized/close values (orange), and differences or one-sided missing values (red). Original provider text remains visible. Structural conflicts such as different track counts disable acceptance and explain why.
- On Harmony's **Release Actions** page, MPL proposes additional recording/artist/label links, ISRCs and provider artwork. Actions unlock as their dependencies finish. MPL prepares links to the editing tools; it does not submit MusicBrainz edits automatically.
- Distributor advisories come from the separately maintained [distributor map](https://djkhjg.github.io/music-distributor-to-platform-map/distributor-platforms.html). The JSON is cached locally and checked for updates daily on startup. Evidence strength and release-date boundaries affect warnings; they do not block selection. Click a warning icon for details.

The `ENABLED_PROVIDERS` switches near the top disable all MPL activity for individual providers. Set a provider to `false` and reload open pages. Disabled non-native providers disappear from the lookup/settings controls; disabled Bandcamp retains Harmony’s native control and functionality. Cached records and saved selections are preserved for re-enabling.

The title matching percentage and date/track-length tolerances are configurable near the top of the script.

## Console commands

Run these in the browser's developer console on a page where MPL is active. Commands return promises; `await` gives you their results.

| Command | Purpose |
| --- | --- |
| `await MPL.cacheStats()` | Counts, providers, cache levels and estimated storage size. |
| `await MPL.listCache()` | Full cached records in numbered groups. |
| `await MPL.listCacheCompact()` | Compact numbered release list. |
| `await MPL.findCache("Flintwick")` | Case-insensitive search across all stored fields, including nested tracks; prints and returns full matches. |
| `await MPL.explainMatch("soundcloud")` | Explains cached/current candidates against the current target: normalization, score, identity checks and acceptance blockers. No network lookup. |
| `await MPL.forgetRelease(3)` | Deletes the provider/key identity numbered 3 in the latest listing/search in this tab, across L1 and L2. |
| `await MPL.clearCache()` | Clears the release cache, retaining preferences and active requests. The distributor dataset cache is separate. |

Deleted releases can be cached again through subsequent observations. Listing numbers are local to the most recent listing/search, not permanent IDs.

Provider IDs: `bandcamp`, `soundcloud`, `traxsource`, `ytmusic`, `sevendigital`.

## Information for cooperating userscripts

### Flow status

On Harmony, MPL announces its presence and flow status through:

- HTML attribute: `document.documentElement.getAttribute("data-harmony-provider-flow-mpl")`
- Session storage key: `harmony-provider-flow:mpl`
- Document event: `harmony:mpl-flow` (read the attribute when the event fires; there is no event payload).

Statuses are `waiting`, `busy` and `finished`. `busy` includes background acquisition and waiting for user input. `finished` means the flow has finished, not that every request succeeded. Prefer the live attribute for presence detection; session storage may survive navigation.

```javascript
function readMplStatus() {
    return document.documentElement.getAttribute("data-harmony-provider-flow-mpl");
}
document.addEventListener("harmony:mpl-flow", () => {
    console.log("MPL status:", readMplStatus());
});
console.log("Initial MPL status:", readMplStatus());
```

The page-visible `window.MPL` console API can also be used by cooperating scripts. Internal cache keys, DOM layout and release-response shapes are implementation details rather than a stable external API.
