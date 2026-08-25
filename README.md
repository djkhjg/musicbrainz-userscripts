# musicbrainz-userscripts
A collection of userscripts for improving and extending MusicBrainz.

Note: All scripts written with the use of LLM ai

## Scripts

### DJ Mix Tracklist

Improves the display of DJ-mix relationships on release pages.  
[Install](dj-mix-tracklist/dj-mix-tracklist.user.js)

- One recording per line
- Displays MusicBrainz relationship ordering, or "?" for missing ordering
- Preserves gaps in track numbering
- Removes disambiguation clutter

### Harmony: Beatport Recovery (WIP)

Restores Beatport functionality to Harmony.  
[Install](harmony-beatport-recovery/harmony-beatport-recovery.user.js)

- Adds a button to the Beatport error message that conducts a Beatport search for Artist+Title
- Locates a release from the search results with a matching UPC
- Returns to Harmony with scraped data (label, catalog number, etc)
- Injects the data into Harmony UI for review, and inserts into the MB seeder
