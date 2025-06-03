# 🔗 Right-Click Link Archiver
Right-click an external URL in a note to create an archive link.

## Current Functionality

Right-click an external URL in a note to create an archive link. This will use your link to *scrape* the selected archive service for available snapshots and pull the latest. If no such snapshot is found, the user will be prompted to create a new one in a browser.

`LINK --> [LINK](URL) | (ARCHIVE)`

`[LINK](EXTERNAL-LINK) --> [MARKDOWN-LINK] | (archive-link)`

`https://example.com/link-to-a-page | archive: https://archive.url/abc123`

By default, naked URLs will be converted using a title scraped from the archive snapshot list.

`https://gist.github.com/n0samu/c8ed07ac640c86db5a753fe466c1b900` ➡ [Essential tips for web archiving. - GitHub](https://gist.github.com/n0samu/c8ed07ac640c86db5a753fe466c1b900) | [(archive)](https://archive.ph/zDGHE)

Customize the divider:

`LINK TO A WEBSITE > 🎈 ARCHIVE: https://archive.url/abc123`

You may also remove an archive link in the context menu.

### 📜 Available services
- archive.today/archive.is -- default is archive.ph
- web.archive.org -- uses archive.org API to scrape a link from a .json.
- ghostarchive.org -- good for YouTube links

## Additional features

Ribbon button to archive every link in the current open note (also available in command palette).

Command palette options to archive every link the the entire vault.

Result reports after batch archiving (can be turned off in settings). It tells you which link in what note was skipped, and at what particular line it was skipped. Perhaps it was typed incorrectly? It would be prudent to check.

Targeted archiving -- exclude entire folders or tags, or target specific folders or tags.

### 🚫 What it doesn't do:

It does not create new snapshots if they don't already exist, but will prompt the user to do so. Complete the captcha to get a link to a new snapshot. The user can opt to use an external browser or the Obsidian web browser to open the selected archive site. It's not exactly automatic, but it's a good reminder to **archive everything.**

This also does not archive content locally.

I wasn't able to find a plugin that did this very specific function that I wanted (create an archive link in one click from context menu) and from archive.today, so I "vibe coded" one into existence. Expect errors.

### To-do
- Implement Wayback Machine in a better way