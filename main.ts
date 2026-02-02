import * as cheerio from 'cheerio';
import {
	App,
	Editor,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	requestUrl,
	Modal,
	ButtonComponent,
	TFile,
	TAbstractFile,
} from "obsidian";


interface LinkArchiverSettings {
  showRibbonIcon: boolean;
  useNakedUrls: boolean;
  useNakedArchiveOnly: boolean;
  scrapePageTitles: boolean;
  autoPickLatestArchive: boolean;
  dividerText: string;
  archiveText: string; // New setting for custom archive text
  archiveSite: string;
  preserveMarkdownLinks: boolean;
  confirmNoteArchiving: boolean;
  requireTimestamps: boolean;
  maxSnapshots: number;
  // Debug mode setting
  debugMode: boolean;
  // Exclusion settings
  excludeFolders: string[];
  excludeFilesWithTags: string[];
  // Inverted exclusion settings
  useInvertedExclusion: boolean;
  targetFolders: string[];
  targetFilesWithTags: string[];
  // Reporting settings
  detailedReporting: boolean;
  // Title cache settings
  enableTitleCache: boolean;
  titleFetchTimeout: number;
}

const DEFAULT_SETTINGS: LinkArchiverSettings = {
  showRibbonIcon: true,
  useNakedUrls: false,
  useNakedArchiveOnly: false,
  scrapePageTitles: true,
  autoPickLatestArchive: true,
  maxSnapshots: 5,
  dividerText: " | ",
  archiveText: "(archive)", // Default archive text
  archiveSite: "web.archive.org",
  preserveMarkdownLinks: true,
  confirmNoteArchiving: true,
  requireTimestamps: true,
  // Debug mode default
  debugMode: false,
  // Default exclusion settings
  excludeFolders: [],
  excludeFilesWithTags: [],
  // Default inverted exclusion settings
  useInvertedExclusion: false,
  targetFolders: [],
  targetFilesWithTags: [],
  // Default reporting settings
  detailedReporting: true,
  // Default title cache settings
  enableTitleCache: true,
  titleFetchTimeout: 10000, // 10 seconds
};

const ARCHIVE_SITES = {
  "ghostarchive.org": "https://ghostarchive.org",
  "web.archive.org": "https://web.archive.org/web"
};

// Error classification for archive services
enum ArchiveErrorType {
	RATE_LIMITED = "rate_limited",
	CAPTCHA_REQUIRED = "captcha_required",
	IP_BLOCKED = "ip_blocked",
	SERVICE_UNAVAILABLE = "service_unavailable",
	NETWORK_ERROR = "network_error",
	UNKNOWN = "unknown"
}

interface ArchiveError {
	type: ArchiveErrorType;
	message: string;
	serviceName: string;
}

// Rate limiter to enforce delays between requests to archive services
class RateLimiter {
	private lastRequestTime: Map<string, number> = new Map();
	private delays: Map<string, number> = new Map();

	constructor() {
		// Set default delays per service (in milliseconds)
		this.delays.set("web.archive.org", 1000); // 1 second for Wayback Machine
		this.delays.set("ghostarchive.org", 2000); // 2 seconds for GhostArchive
		// Archive.today variants get 2 second delay
		this.delays.set("archive.ph", 2000);
		this.delays.set("archive.li", 2000);
		this.delays.set("archive.is", 2000);
		this.delays.set("archive.vn", 2000);
		this.delays.set("archive.md", 2000);
		this.delays.set("archive.today", 2000);
	}

	async waitIfNeeded(serviceName: string): Promise<void> {
		const delay = this.delays.get(serviceName) || 1000;
		const lastRequest = this.lastRequestTime.get(serviceName) || 0;
		const now = Date.now();
		const timeSinceLastRequest = now - lastRequest;

		if (timeSinceLastRequest < delay) {
			const waitTime = delay - timeSinceLastRequest;
			await new Promise(resolve => setTimeout(resolve, waitTime));
		}

		this.lastRequestTime.set(serviceName, Date.now());
	}
}

// Simple cache for archive lookups to avoid duplicate requests
class ArchiveCache {
	private cache: Map<string, { result: any, timestamp: number }> = new Map();
	private ttl: number = 5 * 60 * 1000; // 5 minutes in milliseconds

	get(url: string): any | null {
		const entry = this.cache.get(url);
		if (!entry) return null;

		const now = Date.now();
		if (now - entry.timestamp > this.ttl) {
			// Expired
			this.cache.delete(url);
			return null;
		}

		return entry.result;
	}

	set(url: string, result: any): void {
		this.cache.set(url, {
			result,
			timestamp: Date.now()
		});
	}

	clear(): void {
		this.cache.clear();
	}
}

// LRU cache for page titles with 24-hour TTL
class TitleCache {
	private cache: Map<string, { title: string, timestamp: number }> = new Map();
	private ttl: number = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
	private maxSize: number = 500; // Maximum cache entries

	get(url: string): string | null {
		const entry = this.cache.get(url);
		if (!entry) return null;

		const now = Date.now();
		if (now - entry.timestamp > this.ttl) {
			// Expired
			this.cache.delete(url);
			return null;
		}

		// LRU: move to end by deleting and re-adding
		this.cache.delete(url);
		this.cache.set(url, entry);

		return entry.title;
	}

	set(url: string, title: string): void {
		// If at max size, remove oldest entry (first in map)
		if (this.cache.size >= this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey) {
				this.cache.delete(firstKey);
			}
		}

		this.cache.set(url, {
			title,
			timestamp: Date.now()
		});
	}

	clear(): void {
		this.cache.clear();
	}
}

export default class LinkArchiverPlugin extends Plugin {
	settings: LinkArchiverSettings;
  ribbonIconEl: HTMLElement | null = null;
	private rateLimiter: RateLimiter;
	private archiveCache: ArchiveCache;
	private titleCache: TitleCache;

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		// Migration: auto-switch from deprecated archive.today variants to Wayback Machine
		const deprecatedSites = ['archive.ph', 'archive.li', 'archive.is', 'archive.vn', 'archive.md', 'archive.today'];
		if (deprecatedSites.includes(this.settings.archiveSite)) {
			const oldSite = this.settings.archiveSite;
			console.log(`Migrating from deprecated archive service ${oldSite} to web.archive.org`);
			this.settings.archiveSite = 'web.archive.org';
			await this.saveSettings();
			new Notice(`Archive service migrated from ${oldSite} to Wayback Machine due to CAPTCHA/blocking issues.`);
		}
  }

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async onload() {
		await this.loadSettings();
		this.rateLimiter = new RateLimiter();
		this.archiveCache = new ArchiveCache();
		this.titleCache = new TitleCache();
		this.addSettingTab(new LinkArchiverSettingTab(this.app, this));
		this.updateRibbonIcon();
		
		// Add commands
		this.addCommand({
			id: "archive-link-at-cursor",
			name: "Archive link at cursor",
			editorCallback: (editor: Editor) => this.archiveLinkAtCursor(editor),
		});
		
		this.addCommand({
			id: "archive-all-links-in-note",
			name: "Archive all links in current note",
			editorCallback: (editor: Editor) => this.archiveAllLinksInNote(editor),
		});
		
		this.addCommand({
			id: "archive-all-links-in-vault",
			name: "Archive all links in vault",
			callback: () => this.archiveAllLinksInVault(),
		});
		
		this.addCommand({
			id: "remove-archive-links",
			name: "Remove archive links (debug)",
			callback: () => this.showRemoveArchiveLinksDialog(),
		});
		
		// Add command for inverted exclusion
		this.addCommand({
			id: "archive-targeted-files",
			name: "Archive links in targeted files only",
			callback: () => this.archiveTargetedFiles(),
		});

		// Add convert naked URLs commands
		this.addCommand({
			id: "convert-naked-urls-to-markdown",
			name: "Convert naked URLs to markdown",
			editorCallback: (editor: Editor) => this.convertNakedUrlsToMarkdown(editor),
		});

		this.addCommand({
			id: "convert-all-naked-urls-in-note",
			name: "Convert all naked URLs in current note",
			editorCallback: (editor: Editor) => this.convertAllNakedUrlsInNote(editor),
		});

		// Register a single context menu item
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, view) => {
				const cursor = editor.getCursor();
				const line = editor.getLine(cursor.line);
				const selection = editor.getSelection();
				
				// Check for URL in selected text or at cursor position
				const hasUrlInSelection = selection && this.hasValidUrl(selection);
				const hasUrlInLine = !selection && this.hasValidUrl(line);
				
				if (hasUrlInSelection || hasUrlInLine) {
					// Check if the text already has an archive link
					const textToCheck = hasUrlInSelection ? selection : line;

					// Check if there are naked URLs (not in markdown format)
					const nakedUrlPattern = /(?<!\]\()https?:\/\/[^\s)\]]+(?!\))/;
					const hasNakedUrl = nakedUrlPattern.test(textToCheck);

					if (this.lineContainsArchiveLink(textToCheck)) {
						menu.addItem((item) =>
							item
								.setTitle("Remove archive link")
								.setIcon("trash")
								.onClick(() => {
									const originalLink = this.extractOriginalLinkFromArchiveLine(textToCheck);
									if (originalLink) {
										if (hasUrlInSelection) {
											editor.replaceSelection(originalLink);
										} else {
											editor.setLine(cursor.line, originalLink);
										}
										new Notice("Archive link removed.");
									}
								})
						);
					} else {
						menu.addItem((item) =>
							item
								.setTitle("Archive link")
								.setIcon("link")
								.onClick(() => this.archiveLinkAtCursor(editor))
						);

						// Add convert to markdown option if naked URLs detected and scraping is enabled
						if (hasNakedUrl && this.settings.scrapePageTitles) {
							menu.addItem((item) =>
								item
									.setTitle("Convert to markdown link")
									.setIcon("file-text")
									.onClick(() => this.convertNakedUrlsToMarkdown(editor))
							);
						}
						
						// Add "Create link title" option for links without meaningful titles
						if (this.settings.scrapePageTitles) {
							const linkInfo = this.extractUrlFromLine(textToCheck);
							if (linkInfo) {
								// Check if the link has a meaningful title (not just the URL)
								const hasMeaningfulTitle = linkInfo.displayText && 
									linkInfo.displayText !== linkInfo.originalUrl &&
									!linkInfo.displayText.toLowerCase().includes('http');
								
								if (!hasMeaningfulTitle) {
									menu.addItem((item) =>
										item
											.setTitle("Create link title")
											.setIcon("heading")
											.onClick(() => this.createLinkTitle(editor, linkInfo))
									);
								}
							}
						}
					}
				}
			})
		);
	}
	
	// Create a meaningful title for a markdown link by scraping the URL
	async createLinkTitle(editor: Editor, linkInfo: any) {
		try {
			new Notice("Fetching page title...");
			const title = await this.extractTitleFromUrl(linkInfo.originalUrl);
			
			if (title && title !== linkInfo.originalUrl && title !== "Link") {
				const cursor = editor.getCursor();
				const line = editor.getLine(cursor.line);
				
				// Create the new markdown link with the fetched title
				const newLink = `[${title}](${linkInfo.originalUrl})`;
				
				// Replace the old link with the new one
				const newLine = line.replace(linkInfo.fullMatch, newLink);
				editor.setLine(cursor.line, newLine);
				new Notice("Link title created successfully!");
			} else {
				new Notice("Could not fetch a meaningful title for this link.");
			}
		} catch (error) {
			if (this.settings.debugMode) {
				console.error("Error creating link title:", error);
			}
			new Notice("Error fetching page title. Please try again.");
		}
	}
	
	updateRibbonIcon() {
		if (this.ribbonIconEl) {
			this.ribbonIconEl.remove();
			this.ribbonIconEl = null;
		}

		if (this.settings.showRibbonIcon) {
			this.ribbonIconEl = this.addRibbonIcon("link", "Archive links in note", () => {
				this.archiveAllLinksInCurrentNote();
			});
		}
	}

	hasValidUrl(text: string): boolean {
		// Improved regex patterns to match a wider variety of URLs
		const markdownLinkPattern = /\[[^\]]*\]\(https?:\/\/[^\s\)]+\)/;
		const nakedUrlPattern = /https?:\/\/[^\s\)]+/;
		return markdownLinkPattern.test(text) || nakedUrlPattern.test(text);
	}

	extractUrlFromLine(line: string): { originalUrl: string; displayText: string; fullMatch: string; isNaked: boolean } | null {
		// Skip code blocks and quotes
		if (line.trim().startsWith("```") || line.trim().startsWith(">") || line.trim().startsWith("$$")) {
			return null;
		}
		
		// Try markdown link first
		const markdownMatch = line.match(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/);
		if (markdownMatch) {
			// Skip if the match is inside a code block
			if (this.isInsideCodeBlock(line, markdownMatch.index!)) {
				return null;
			}
			return {
				originalUrl: markdownMatch[2],
				displayText: markdownMatch[1] || markdownMatch[2],
				fullMatch: markdownMatch[0],
				isNaked: false
			};
		}

		// Try HTML anchor tag
		const htmlMatch = line.match(/<a\s+[^>]*?href\s*=\s*['"](https?:\/\/[^'"]+)['"][^>]*?>(.*?)<\/a>/i);
		if (htmlMatch) {
			if (this.isInsideCodeBlock(line, htmlMatch.index!)) {
				return null;
			}
			return {
				originalUrl: htmlMatch[1],
				displayText: htmlMatch[2] || htmlMatch[1],
				fullMatch: htmlMatch[0],
				isNaked: false
			};
		}

		// Try naked URL
		const nakedMatch = line.match(/(https?:\/\/[^\s]+)/);
		if (nakedMatch) {
			if (this.isInsideCodeBlock(line, nakedMatch.index!)) {
				return null;
			}
			return {
				originalUrl: nakedMatch[1],
				displayText: nakedMatch[1],
				fullMatch: nakedMatch[0],
				isNaked: true
			};
		}

		return null;
	}

	private isInsideCodeBlock(line: string, index: number): boolean {
		// Check for inline code (single backticks)
		const backtickSegments = line.split('`');
		let inInlineCode = false;
		let currentPos = 0;
		
		for (const segment of backtickSegments) {
			const segmentStart = currentPos;
			const segmentEnd = currentPos + segment.length;
			
			if (inInlineCode && index >= segmentStart && index < segmentEnd) {
				return true;
			}
			
			inInlineCode = !inInlineCode;
			currentPos = segmentEnd + 1; // +1 for the backtick
		}
		
		// Check for code blocks (triple backticks)
		const tripleBacktickCount = (line.match(/```/g) || []).length;
		return tripleBacktickCount > 0;
	}
	
	// Helper method to check if a line is in a code block or quote
	isCodeBlockOrQuote(lines: string[], lineIndex: number): boolean {
		// Check if the current line is a code block marker or quote
		const line = lines[lineIndex];
		if (line.trim().startsWith("```") || line.trim().startsWith(">") || line.trim().startsWith("$$")) {
			return true;
		}
		
		// Check if we're inside a code block
		let inCodeBlock = false;
		for (let i = 0; i < lineIndex; i++) {
			if (lines[i].trim().startsWith("```")) {
				inCodeBlock = !inCodeBlock;
			}
		}
		
		return inCodeBlock;
	}

	async archiveLinkAtCursor(editor: Editor) {
	 const cursor = editor.getCursor();
	 const line = editor.getLine(cursor.line);
	 
	 // Check if line is in a code block
	 const content = editor.getValue();
	 const lines = content.split('\n');
	 if (this.isCodeBlockOrQuote(lines, cursor.line)) {
	   new Notice("No valid URL found on this line.");
	   return;
	 }
	 
	 // Check if line already contains an archive link
	 if (this.lineContainsArchiveLink(line)) {
	   new Notice("This line already contains an archive link. Remove it first if you want to re-archive.");
	   return;
	 }
	 
	 const linkInfo = this.extractUrlFromLine(line);
	 if (!linkInfo) {
	   new Notice("No valid URL found on this line.");
	   return;
	 }
	 
	 // Check if the URL is an archive URL
	 if (this.isArchiveUrl(linkInfo.originalUrl)) {
	   new Notice("Cannot archive an archive URL.");
	   return;
	 }

	 // Handle ghostarchive URLs specifically
	 const ghostArchivePattern = /https?:\/\/ghostarchive\.org\/(archive|varchive)\/[a-zA-Z0-9]+/g;
	 if (linkInfo.originalUrl.match(ghostArchivePattern)) {
	   // Remove ghostarchive link
	   const originalLink = this.extractOriginalLinkFromArchiveLine(line);
	   if (originalLink) {
	     editor.setLine(cursor.line, originalLink);
	     new Notice("Ghostarchive link removed.");
	   } else {
	     new Notice("Could not remove ghostarchive link.");
	   }
	   return;
	 }

		new Notice("Checking for existing archives...", 3000);

		try {
			const result = await this.getExistingArchive(linkInfo.originalUrl);
			
			if (result.foundArchive) {
				if (result.snapshots && result.snapshots.length > 1 && !this.settings.autoPickLatestArchive) {
				// Multiple snapshots found, let user choose
	         const selectedUrl = await this.showSnapshotModal(result.snapshots);
	         if (selectedUrl !== null) {  // Changed from if (selectedUrl)
	           // Get fresh line data to ensure we have the most current state
	           const currentLineNumber = cursor.line;
	           const currentLine = editor.getLine(currentLineNumber);
	           const currentLinkInfo = this.extractUrlFromLine(currentLine);
	           if (currentLinkInfo) {
	             this.replaceLinkInLine(editor, currentLineNumber, currentLine, currentLinkInfo, selectedUrl);
	             new Notice("Link archived with selected snapshot.");
	           } else {
	             new Notice("Could not find link on current line.");
	           }
	         }
				} else if (result.archivedUrl) {
					// Single archive found or auto-pick enabled
					this.replaceLinkInLine(editor, cursor.line, line, linkInfo, result.archivedUrl);
					new Notice("Link archived with existing snapshot.");
				}
			} else {
				// No existing archive found, prompt user to create one
				const newArchiveUrl = await this.showArchivePromptModal(linkInfo.originalUrl);
				if (newArchiveUrl) {
					// Get fresh line data
					const currentLineNumber = cursor.line;
					const currentLine = editor.getLine(currentLineNumber);
					const currentLinkInfo = this.extractUrlFromLine(currentLine);
					
					if (currentLinkInfo) {
						this.replaceLinkInLine(editor, currentLineNumber, currentLine, currentLinkInfo, newArchiveUrl);
						new Notice("Link archived with new snapshot.");
					} else {
						new Notice("Could not find link on current line.");
					}
				}
			}
		} catch (error) {
			if (this.settings.debugMode) {
				console.error("Error archiving link:", error);
			}
			new Notice("Error checking for archives. Please try again.");
		}
	}
	
	async showArchivePromptModal(originalUrl: string): Promise<string | null> {
		return new Promise((resolve) => {
			new ArchivePromptModal(this.app, originalUrl, resolve, this).open();
		});
	}

	async extractTitleFromUrl(url: string, retryCount = 0): Promise<string> {
		// Check cache first (if enabled and not a retry)
		if (this.settings.enableTitleCache && retryCount === 0) {
			const cachedTitle = this.titleCache.get(url);
			if (cachedTitle) {
				if (this.settings.debugMode) {
					console.log(`Using cached title for: ${url}`);
				}
				return cachedTitle;
			}
		}

// Helper function to detect YouTube URLs
const isYouTube = (url: string) => url.includes('youtube.com/watch') || url.includes('youtu.be/');

// Helper function to detect GhostArchive URLs
const isGhostArchive = (url: string) => url.includes('ghostarchive.org/archive/') || url.includes('ghostarchive.org/varchive/');

// Helper function to detect Wayback Machine URLs
const isWaybackMachine = (url: string) => url.includes('web.archive.org');

		try {
			// Enhanced headers to avoid detection and improve success rate
			const headers = {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
				'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
				'Accept-Language': 'en-US,en;q=0.5',
				'Accept-Encoding': 'gzip, deflate',
				'Connection': 'keep-alive',
				'Upgrade-Insecure-Requests': '1',
			};

			// Create a promise that rejects after timeout
			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error('Title fetch timeout')), this.settings.titleFetchTimeout);
			});

			// Race between the fetch and the timeout
			const response = await Promise.race([
				requestUrl({ url: url, headers: headers }),
				timeoutPromise
			]);

			if (response.status === 200) {
				const $ = cheerio.load(response.text);
				let title = '';

    // For GhostArchive URLs, extract the archived page's title
    if (isGhostArchive(url)) {
      // GhostArchive-specific title cleaning
      const cleanGhostTitle = (title: string): string => {
        return title
          .replace(/ - GhostArchive$/, '')
          .replace(/ \| GhostArchive$/, '')
          .replace(/GhostArchive - /, '')
          .replace(/^GhostArchive:\s*/i, '')
          .trim();
      };

      // Apply cleaning to all title sources
      title = cleanGhostTitle(title);
					// GhostArchive pages contain the original title
					// Try og:title first (most reliable for archived content)
					title = $('meta[property="og:title"]').attr('content')?.trim() || '';

					// Try meta name="title"
					if (!title) {
						title = $('meta[name="title"]').attr('content')?.trim() || '';
					}

					// Try to find title in the page content - look for common selectors
					if (!title) {
						title = $('h1').first().text().trim() ||
								$('.video-title').first().text().trim() ||
								$('.page-title').first().text().trim() ||
								$('.title').first().text().trim() ||
								$('[class*="title"]').first().text().trim();
					}

					// Fall back to <title> tag, removing "GhostArchive" suffix if present
					if (!title) {
						title = $('title').first().text().trim();
						title = title.replace(/ - GhostArchive$/, '')
									 .replace(/ \| GhostArchive$/, '')
									 .replace(/GhostArchive - /, '')
									 .trim();
					}

					// Additional cleanup for GhostArchive titles
					if (title) {
						title = title.replace(/^GhostArchive:\s*/i, '').trim();
					}
				}
    // For YouTube, prioritize meta tags over <title> (which includes " - YouTube")
    else if (isYouTube(url)) {
					// 1. og:title meta tag (best for YouTube)
					title = $('meta[property="og:title"]').attr('content')?.trim() || '';

					// 2. twitter:title meta tag
					if (!title) {
						title = $('meta[name="twitter:title"]').attr('content')?.trim() || '';
					}

					// 3. name meta tag
					if (!title) {
						title = $('meta[name="title"]').attr('content')?.trim() || '';
					}

					// 4. <title> tag (as last resort, will have " - YouTube" suffix)
					if (!title) {
						title = $('title').first().text().trim();
						// Remove " - YouTube" suffix (with or without leading content)
						title = title.replace(/ - YouTube$/, '').replace(/^- YouTube$/, '').replace(/^YouTube$/, '');
					}
				} else {
					// 1. <title> tag
					title = $('title').first().text().trim();

					// 2. og:title meta tag
					if (!title) {
						title = $('meta[property="og:title"]').attr('content')?.trim() || '';
					}

					// 3. twitter:title meta tag
					if (!title) {
						title = $('meta[name="twitter:title"]').attr('content')?.trim() || '';
					}
				}

				// Clean up title
				title = title.trim();

    // Special handling for YouTube to avoid generic titles and bad titles
    if (isYouTube(url)) {
					const badTitles = [
						'youtube.com', 'www.youtube.com', 'youtube', '- youtube', 'youtu.be', '',
						'Enjoy the videos and music you love, upload original content, and share it all with friends, family, and the world on YouTube.',
						'YouTube'
					];
					
					const isBadTitle = badTitles.includes(title.toLowerCase()) ||
									   title.length === 0 ||
									   title === url;

					// If we got a bad title, try GhostArchive fallback immediately
					if (isBadTitle || retryCount === 0) {
						console.log(`Got bad YouTube title: "${title}", trying GhostArchive fallback...`);
						const ghostTitle = await this.extractTitleFromGhostArchive(url);
						if (ghostTitle && ghostTitle !== url && !badTitles.includes(ghostTitle.toLowerCase()) && ghostTitle !== 'Link') {
							title = ghostTitle;
							console.log(`Successfully got title from GhostArchive: "${title}"`);
						}
					}
				}

				// Additional fallback for all URLs if no title found
				if (!title || title === url) {
					// 4. meta description (for all URLs)
					title = $('meta[name="description"]').attr('content')?.trim() || '';
					// Truncate long descriptions
					if (title && title.length > 100) {
						title = title.substring(0, 100) + '...';
					}
				}

				// 5. <h1> tag
				if (!title || title === url) {
					title = $('h1').first().text().trim();
				}

				// 6. Domain name fallback
				if (!title || title === url) {
					const urlObj = new URL(url);
					title = urlObj.hostname.replace(/^www\./, '');
				}

				// Cache the result (even fallback results)
				if (this.settings.enableTitleCache && title) {
					this.titleCache.set(url, title);
				}

				return title || 'Link';
			}

			// If we couldn't get a title, extract domain
			const urlObj = new URL(url);
			const fallbackTitle = urlObj.hostname.replace(/^www\./, '');

			// Cache fallback too
			if (this.settings.enableTitleCache) {
				this.titleCache.set(url, fallbackTitle);
			}

			return fallbackTitle;
		} catch (error) {
			if (this.settings.debugMode) {
				console.error("Error extracting title:", error);
			}

    // Special fallback for YouTube: try to get title from GhostArchive if it exists
    if (isYouTube(url) && retryCount === 0) {
				console.log("YouTube scraping failed, trying GhostArchive fallback...");
				const ghostTitle = await this.extractTitleFromGhostArchive(url);
				if (ghostTitle && ghostTitle !== url && ghostTitle !== 'Link') {
					// Cache the result
					if (this.settings.enableTitleCache) {
						this.titleCache.set(url, ghostTitle);
					}
					return ghostTitle;
				}
			}

			// Implement retry logic with exponential backoff (only for non-timeout errors)
			const isTimeout = error.message && error.message.includes('timeout');
			if (!isTimeout && retryCount < 2) { // Try up to 3 times total (initial + 2 retries)
				const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s delay

				// Wait for the delay period
				await new Promise(resolve => setTimeout(resolve, delay));

				// Retry with incremented counter
				return this.extractTitleFromUrl(url, retryCount + 1);
			}

			// If all retries failed or timeout, fall back to domain name
			try {
				const urlObj = new URL(url);
				const fallbackTitle = urlObj.hostname.replace(/^www\./, '');

				// Cache fallback
				if (this.settings.enableTitleCache) {
					this.titleCache.set(url, fallbackTitle);
				}

				return fallbackTitle;
			} catch {
				return "Link";
			}
		}
	}

	// Fallback: Extract title from GhostArchive for YouTube videos
	private async extractTitleFromGhostArchive(youtubeUrl: string): Promise<string> {
		try {
			// Extract video ID
			const youtubeMatch = youtubeUrl.match(/[?&]v=([^&]+)/) ||
								youtubeUrl.match(/youtu\.be\/([^?&]+)/) ||
								youtubeUrl.match(/youtube\.com\/embed\/([^?&]+)/) ||
								youtubeUrl.match(/youtube\.com\/v\/([^?&]+)/);

			if (!youtubeMatch || !youtubeMatch[1]) {
				return youtubeUrl;
			}

			const videoId = youtubeMatch[1];
			const ghostUrl = `https://ghostarchive.org/varchive/${videoId}`;

			console.log(`Attempting to extract title from GhostArchive: ${ghostUrl}`);

			const response = await requestUrl({
				url: ghostUrl,
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
					'Accept-Language': 'en-US,en;q=0.5',
					'Accept-Encoding': 'gzip, deflate',
					'Connection': 'keep-alive',
					'Upgrade-Insecure-Requests': '1',
				},
				throw: false
			});

			if (response.status === 200) {
				const $ = cheerio.load(response.text);
				let title = '';

				console.log(`GhostArchive page loaded successfully, extracting title...`);

				// Try multiple selectors specific to GhostArchive's layout
				// 1. Meta og:title (most reliable)
				title = $('meta[property="og:title"]').attr('content')?.trim() || '';
				if (title) console.log(`Found title in og:title: "${title}"`);

				// 2. Page title (remove GhostArchive suffix)
				if (!title) {
					const rawTitle = $('title').first().text().trim();
					console.log(`Found raw title tag: "${rawTitle}"`);
					// Extract the actual video title from GhostArchive page title
					// Format is usually: "[Video Title] - GhostArchive"
					const titleMatch = rawTitle.match(/^(.*?)\s*-?\s*GhostArchive$/i);
					if (titleMatch && titleMatch[1]) {
						title = titleMatch[1].trim();
					} else {
						title = rawTitle.replace(/ - GhostArchive$/, '')
									 .replace(/ \| GhostArchive$/, '')
									 .replace(/GhostArchive - /, '')
									 .replace(/^GhostArchive:\s*/i, '')
									 .trim();
					}
					if (title && title !== rawTitle) console.log(`Cleaned title: "${title}"`);
				}

				// 3. Meta name="title"
				if (!title) {
					title = $('meta[name="title"]').attr('content')?.trim() || '';
					if (title) console.log(`Found title in meta name="title": "${title}"`);
				}

				// 4. Meta twitter:title
				if (!title) {
					title = $('meta[name="twitter:title"]').attr('content')?.trim() || '';
					if (title) console.log(`Found title in twitter:title: "${title}"`);
				}

				// 5. Look for h1 or main heading
				if (!title) {
					title = $('h1').first().text().trim();
					if (title) console.log(`Found title in h1: "${title}"`);
				}

				// 6. Look for common video title classes
				if (!title) {
					const classSelectors = ['.video-title', '.page-title', '.title', '[class*="title"]', '[class*="video"]'];
					for (const selector of classSelectors) {
						title = $(selector).first().text().trim();
						if (title) {
							console.log(`Found title in ${selector}: "${title}"`);
							break;
						}
					}
				}

				// 7. Look for iframe and nearby elements
				if (!title) {
					const iframe = $('iframe[src*="youtube.com"]');
					if (iframe.length) {
						console.log(`Found YouTube iframe, looking for nearby title...`);
						// Check iframe's parent and siblings
						title = iframe.parent().find('h1, h2, h3, .title').first().text().trim() ||
								iframe.siblings('h1, h2, h3, .title').first().text().trim() ||
								iframe.closest('div').find('h1, h2, h3, .title').first().text().trim();
						if (title) console.log(`Found title near iframe: "${title}"`);
					}
				}

				// Clean up any GhostArchive branding that slipped through
				if (title) {
					title = title.replace(/\s*[-|]\s*GhostArchive\s*$/i, '').trim();
				}

				if (title && title !== 'Enjoy the videos and music you love, upload original content, and share it all with friends, family, and the world on YouTube.') {
					console.log(`Successfully extracted title from GhostArchive: "${title}"`);
					return title;
				} else {
					console.log(`No valid title found on GhostArchive page`);
					// Log first 500 chars of page to help debug
					if (this.settings.debugMode) {
						console.log(`First 500 chars of page:`, response.text.substring(0, 500));
					}
				}
			} else if (response.status === 404) {
				console.log(`GhostArchive URL not found: ${ghostUrl}`);
			} else {
				console.log(`GhostArchive returned status ${response.status}`);
			}
		} catch (error) {
			console.log(`Error extracting title from GhostArchive: ${error}`);
		}

		// If GhostArchive fails, try to get title directly from YouTube
		try {
			console.log(`Attempting to extract title directly from YouTube: ${youtubeUrl}`);
			
			const response = await requestUrl({
				url: youtubeUrl,
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
					'Accept-Language': 'en-US,en;q=0.5',
					'Accept-Encoding': 'gzip, deflate',
					'Connection': 'keep-alive',
					'Upgrade-Insecure-Requests': '1',
				},
				throw: false
			});

			if (response.status === 200) {
				const $ = cheerio.load(response.text);
				let title = '';

				console.log(`YouTube page loaded successfully, extracting title...`);

				// Try multiple selectors for YouTube
				// 1. Meta og:title (most reliable for YouTube)
				title = $('meta[property="og:title"]').attr('content')?.trim() || '';
				if (title) console.log(`Found title in YouTube og:title: "${title}"`);

				// 2. Page title (remove YouTube suffix)
				if (!title) {
					const rawTitle = $('title').first().text().trim();
					console.log(`Found raw YouTube title tag: "${rawTitle}"`);
					// Extract the actual video title from YouTube page title
					// Format is usually: "[Video Title] - YouTube"
					const titleMatch = rawTitle.match(/^(.*?)\s*-?\s*YouTube$/i);
					if (titleMatch && titleMatch[1]) {
						title = titleMatch[1].trim();
					} else {
						title = rawTitle.replace(/ - YouTube$/, '')
									 .replace(/^- YouTube$/, '')
									 .replace(/^YouTube$/, '')
									 .trim();
					}
					if (title && title !== rawTitle) console.log(`Cleaned YouTube title: "${title}"`);
				}

				// 3. Meta name="title"
				if (!title) {
					title = $('meta[name="title"]').attr('content')?.trim() || '';
					if (title) console.log(`Found title in YouTube meta name="title": "${title}"`);
				}

				// 4. Look for h1 with specific YouTube classes
				if (!title) {
					title = $('h1.ytd-video-primary-info-renderer').first().text().trim() ||
							$('h1.title').first().text().trim() ||
							$('h1').first().text().trim();
					if (title) console.log(`Found title in YouTube h1: "${title}"`);
				}

				if (title && title !== 'Enjoy the videos and music you love, upload original content, and share it all with friends, family, and the world on YouTube.') {
					console.log(`Successfully extracted title from YouTube: "${title}"`);
					return title;
				} else {
					console.log(`No valid title found on YouTube page`);
				}
			}
		} catch (error) {
			console.log(`Error extracting title directly from YouTube: ${error}`);
		}

		return youtubeUrl;
	}

	async replaceLinkInLine(editor: Editor, lineNumber: number, originalLine: string, linkInfo: any, archivedUrl: string) {
		// Extract the plain URL if archivedUrl is a markdown link
		let plainArchivedUrl = archivedUrl;
		const markdownMatch = archivedUrl.match(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/);
		if (markdownMatch) {
			plainArchivedUrl = markdownMatch[2];
		}
		
		// For ghostarchive.org, ensure URL is properly formatted
		if (this.settings.archiveSite === 'ghostarchive.org') {
		  // Allow both regular and video archives
		  if (!plainArchivedUrl.includes('ghostarchive.org/archive/') &&
		      !plainArchivedUrl.includes('ghostarchive.org/varchive/')) {
		    new Notice(`Invalid ghostarchive.org URL: ${plainArchivedUrl}`);
		    return;
		  }
		}
		
		let newLine;
		
		// Determine how to format the original link and archive link
		let originalPart, archivedPart;
	  
	  // Check if it's an HTML anchor tag
	  if (linkInfo.fullMatch.startsWith('<a')) {
	    // For HTML links, preserve the original tag and append archive link
	    originalPart = linkInfo.fullMatch;
	    archivedPart = `<a href="${plainArchivedUrl}">archive</a>`;
	  }
	  // Handle markdown and naked URLs
	  else {
	    // Case 1: If it's a markdown link and we want to preserve it
	    if (!linkInfo.isNaked && this.settings.preserveMarkdownLinks) {
	      // Keep the original markdown link as is
	      originalPart = `[${linkInfo.displayText}](${linkInfo.originalUrl})`;
	    }
	    // Case 2: If we want to use naked URLs
	    else if (this.settings.useNakedUrls) {
	      // Just use the naked URL, regardless of whether it was markdown before
	      originalPart = linkInfo.originalUrl;
	    }
	    // Case 3: Default to markdown links (convert naked URLs to markdown or update existing markdown links)
	    else {
	      // For both naked URLs and markdown links when preserveMarkdownLinks is disabled
	      let displayText;
	      
	      // Always try to get a meaningful title from the website
	      try {
	        displayText = await this.extractTitleFromUrl(linkInfo.originalUrl);
	      } catch {
	        // If title scraping fails, use a more descriptive part of the URL if possible
	        try {
	          const urlObj = new URL(linkInfo.originalUrl);
	          const pathParts = urlObj.pathname.split('/').filter(part => part.length > 0);
	          
	          if (pathParts.length > 0) {
	            // Use the last meaningful path segment, replacing hyphens with spaces
	            const lastSegment = pathParts[pathParts.length - 1]
	              .replace(/\.html$|\.php$|\.aspx$/i, '')
	              .replace(/-/g, ' ')
	              .replace(/_/g, ' ');
	              
	            if (lastSegment.length > 3) {
	              // Capitalize first letter of each word
	              displayText = lastSegment
	                .split(' ')
	                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
	                .join(' ');
	            } else {
	              displayText = urlObj.hostname;
	            }
	          } else {
	            displayText = urlObj.hostname;
	          }
	        } catch {
	          // If URL parsing fails, use the original display text for markdown links
	          // or the URL itself for naked URLs
	          displayText = linkInfo.isNaked ? linkInfo.originalUrl : linkInfo.displayText;
	        }
	      }
	      
	      originalPart = `[${displayText}](${linkInfo.originalUrl})`;
	    }
	    
	    // Format the archive part based on settings
	    if (this.settings.useNakedUrls || this.settings.useNakedArchiveOnly) {
	      // Use naked URL for archive
	      archivedPart = plainArchivedUrl;
	    } else {
	      // Use markdown for archive with custom text
	      archivedPart = `[${this.settings.archiveText}](${plainArchivedUrl})`;
	    }
	  }
	  
	  // Combine with the user's divider text
	  const replacement = `${originalPart}${this.settings.dividerText}${archivedPart}`;
	  
	  // More robust replacement - ensure we're replacing the exact match
	  if (originalLine.includes(linkInfo.fullMatch)) {
	    newLine = originalLine.replace(linkInfo.fullMatch, replacement);
	    editor.setLine(lineNumber, newLine);
	  } else {
	    // Fallback: if exact match fails, log and show error
	    if (this.settings.debugMode) {
	  console.warn(`Could not find exact match for: ${linkInfo.fullMatch} in line: ${originalLine}`);
	 }
	    new Notice(`Could not match link in line for replacement: ${linkInfo.originalUrl}`);
	  }
}

	async archiveAllLinksInNote(editor: Editor) {
	   // Check if the file should be excluded
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile) {
			const exclusionResult = this.shouldExcludeFile(activeFile);
			if (exclusionResult.excluded) {
				new Notice(`File excluded from archiving: ${exclusionResult.reason}`);
				return;
			}
		}
		
		const content = editor.getValue();
		const lines = content.split('\n');
		let archivedCount = 0;
		
		// Detailed tracking of skipped links
		const skippedLinks = {
			alreadyArchived: 0,
			isArchiveUrl: 0,
			noSnapshots: 0,
			errors: 0,
			rateLimited: 0
		};
		
		// For detailed reporting
		const skippedDetails: Array<{line: number, url: string, reason: string}> = [];
	 
	 new Notice("Starting to archive links in note...");
	 
	 // Process links one by one with delays to avoid overwhelming archive services
	 for (let i = 0; i < lines.length; i++) {
	   // Skip code blocks and quotes
	   if (this.isCodeBlockOrQuote(lines, i)) {
	     continue;
	   }
	   
	   const linkInfo = this.extractUrlFromLine(lines[i]);
	   
	   // Skip if no link found
	   if (!linkInfo) {
	     continue;
	   }
	   
	   // Skip if line already has archive link
	   if (this.lineContainsArchiveLink(lines[i])) {
	     skippedLinks.alreadyArchived++;
	     if (this.settings.detailedReporting) {
	       skippedDetails.push({
	         line: i + 1,
	         url: linkInfo.originalUrl,
	         reason: "Already has archive link"
	       });
	     }
	     continue;
	   }
    
    // Skip if the URL is an archive URL (including ghostarchive)
    if (this.isArchiveUrl(linkInfo.originalUrl)) {
      skippedLinks.isArchiveUrl++;
      if (this.settings.detailedReporting) {
        skippedDetails.push({
          line: i + 1,
          url: linkInfo.originalUrl,
          reason: "Is an archive URL"
        });
      }
      continue;
    }
    
    // Skip ghostarchive URLs specifically
    const ghostArchivePattern = new RegExp(
        "https?://ghostarchive\\.org/(archive|varchive)/[a-z0-9]+",
        "gi"
    );
    if (linkInfo.originalUrl.match(ghostArchivePattern)) {
      skippedLinks.isArchiveUrl++;
      if (this.settings.detailedReporting) {
        skippedDetails.push({
          line: i + 1,
          url: linkInfo.originalUrl,
          reason: "Is a ghostarchive URL"
        });
      }
      continue;
    }
    
    try {
      new Notice(`Checking link ${archivedCount + Object.values(skippedLinks).reduce((a, b) => a + b, 0) + 1}...`, 1000);
      
      const result = await this.getExistingArchive(linkInfo.originalUrl);
      
      // Check for rate limiting
      if (result.rateLimited) {
        skippedLinks.rateLimited++;
        if (this.settings.detailedReporting) {
          skippedDetails.push({
            line: i + 1,
            url: linkInfo.originalUrl,
            reason: "Rate limited by archive service"
          });
        }
        
        // If rate limited, show a notice and stop processing
        new Notice("Rate limited by archive service. Please try again later.");
        break;
      }
      
      if (result.foundArchive && result.archivedUrl) {
        this.replaceLinkInLine(editor, i, lines[i], linkInfo, result.archivedUrl);
        archivedCount++;
        
        // Update lines array to reflect changes for next iterations
        lines[i] = editor.getLine(i);
      } else {
        skippedLinks.noSnapshots++;
        if (this.settings.detailedReporting) {
          skippedDetails.push({
            line: i + 1,
            url: linkInfo.originalUrl,
            reason: "No archive snapshots available"
          });
        }
      }
      
      // Add delay between requests to be nice to archive services
      if (i < lines.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
      }
    } catch (error) {
      if (this.settings.debugMode) {
    console.error(`Error archiving link on line ${i + 1}:`, error);
   }
      
      // Check if the error is related to rate limiting
      if (error.message && (
          error.message.includes("rate limit") ||
          error.message.includes("too many requests") ||
          error.message.includes("429")
      )) {
        skippedLinks.rateLimited++;
        if (this.settings.detailedReporting) {
          skippedDetails.push({
            line: i + 1,
            url: linkInfo.originalUrl,
            reason: "Rate limited by archive service"
          });
        }
        
        // If rate limited, show a notice and stop processing
        new Notice("Rate limited by archive service. Please try again later.");
        break;
      } else {
        skippedLinks.errors++;
        if (this.settings.detailedReporting) {
          skippedDetails.push({
            line: i + 1,
            url: linkInfo.originalUrl,
            reason: `Error: ${error.message || "Unknown error"}`
          });
        }
      }
    }
  }

  // Calculate total skipped
  const totalSkipped = Object.values(skippedLinks).reduce((a, b) => a + b, 0);
  
  // Show detailed report if enabled
  if (this.settings.detailedReporting && skippedDetails.length > 0) {
    // Create a report modal
    new ArchiveReportModal(this.app, {
      archivedCount,
      skippedLinks,
      skippedDetails,
      isNote: true,
      filePath: activeFile ? activeFile.path : null
    }).open();
  } else {
    // Simple notice
    new Notice(`Note archiving complete. Archived: ${archivedCount}, Skipped: ${totalSkipped}`);
  }
  
  return {
    archivedCount,
    skippedLinks,
    skippedDetails
  };
}

	// Convert naked URLs to markdown links at cursor position or in selection
	async convertNakedUrlsToMarkdown(editor: Editor) {
		if (!this.settings.scrapePageTitles) {
			new Notice("Please enable 'Scrape page titles' in settings to use this feature.");
			return;
		}

		const cursor = editor.getCursor();
		const selection = editor.getSelection();

		// Check if user has selected text
		if (selection) {
			await this.convertUrlsInText(editor, selection, cursor.line, true);
		} else {
			// Work on current line
			const line = editor.getLine(cursor.line);
			await this.convertUrlsInText(editor, line, cursor.line, false);
		}
	}

	// Helper method to convert URLs in a given text
	async convertUrlsInText(editor: Editor, text: string, lineNumber: number, isSelection: boolean = false) {
		// Find all naked URLs (not already in markdown links)
		const urlRegex = /(?<!\]\()https?:\/\/[^\s)\]]+(?!\))/g;
		const urls = text.match(urlRegex);

		if (!urls || urls.length === 0) {
			new Notice("No naked URLs found to convert.");
			return;
		}

		// Skip URLs in code blocks (only check if not a selection)
		if (!isSelection) {
			const line = editor.getLine(lineNumber);
			if (this.isCodeBlockOrQuote(editor.getValue().split('\n'), lineNumber)) {
				new Notice("Cannot convert URLs inside code blocks or quotes.");
				return;
			}
		}

		new Notice(`Converting ${urls.length} naked URL${urls.length > 1 ? 's' : ''}...`);

		let modifiedText = text;
		let successCount = 0;

		// Process URLs one by one
		for (const url of urls) {
			try {
				const title = await this.extractTitleFromUrl(url);

				// Replace the naked URL with markdown link
				modifiedText = modifiedText.replace(url, `[${title}](${url})`);
				successCount++;

				// Show progress for multiple URLs
				if (urls.length > 1) {
					new Notice(`Converted ${successCount}/${urls.length} URLs...`);
				}

				// Add delay between requests if multiple URLs
				if (urls.indexOf(url) < urls.length - 1) {
					await new Promise(resolve => setTimeout(resolve, 500));
				}
			} catch (error) {
				if (this.settings.debugMode) {
					console.error(`Error converting URL ${url}:`, error);
				}
			}
		}

		// Replace the text - either selection or entire line
		if (isSelection) {
			editor.replaceSelection(modifiedText);
		} else {
			editor.setLine(lineNumber, modifiedText);
		}

		new Notice(`Successfully converted ${successCount} URL${successCount > 1 ? 's' : ''} to markdown.`);
	}

	// Convert all naked URLs in the entire note
	async convertAllNakedUrlsInNote(editor: Editor) {
		if (!this.settings.scrapePageTitles) {
			new Notice("Please enable 'Scrape page titles' in settings to use this feature.");
			return;
		}

		const content = editor.getValue();
		const lines = content.split('\n');
		let totalConverted = 0;

		new Notice("Converting all naked URLs in note...");

		// Process line by line
		for (let i = 0; i < lines.length; i++) {
			// Skip code blocks and quotes
			if (this.isCodeBlockOrQuote(lines, i)) {
				continue;
			}

			const line = lines[i];

			// Find naked URLs (not already in markdown links)
			const urlRegex = /(?<!\]\()https?:\/\/[^\s)\]]+(?!\))/g;
			const urls = line.match(urlRegex);

			if (!urls || urls.length === 0) {
				continue;
			}

			let modifiedLine = line;

			// Process each URL in the line
			for (const url of urls) {
				try {
					const title = await this.extractTitleFromUrl(url);

					// Replace naked URL with markdown link
					modifiedLine = modifiedLine.replace(url, `[${title}](${url})`);
					totalConverted++;

					// Add delay between requests
					await new Promise(resolve => setTimeout(resolve, 500));
				} catch (error) {
					if (this.settings.debugMode) {
						console.error(`Error converting URL ${url} on line ${i + 1}:`, error);
					}
				}
			}

			// Update the line
			editor.setLine(i, modifiedLine);
			lines[i] = modifiedLine; // Keep local array in sync
		}

		new Notice(`Conversion complete. Converted ${totalConverted} naked URL${totalConverted !== 1 ? 's' : ''} to markdown.`);
	}

	async archiveAllLinksInCurrentNote() {
  const leaf = this.app.workspace.getMostRecentLeaf();

  if (leaf && leaf.view instanceof MarkdownView) {
    // Ensure focus returns to this leaf so editor is accessible
    this.app.workspace.setActiveLeaf(leaf, { focus: true });

    // Wait briefly to allow the focus to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeLeaf) {
      if (this.settings.confirmNoteArchiving) {
        new ArchiveNoteModal(this.app, () => {
          this.archiveAllLinksInNote(activeLeaf.editor);
        }).open();
      } else {
        this.archiveAllLinksInNote(activeLeaf.editor);
      }
    } else {
      new Notice("No active markdown editor found after refocusing.");
    }
  } else {
    new Notice("No active markdown view to archive.");
  }
}

	async archiveAllLinksInVault() {
  new ArchiveVaultModal(this.app, async () => {
    const files = this.app.vault.getMarkdownFiles();
    let totalArchived = 0;
    
    // Detailed tracking
    const skippedLinks = {
      alreadyArchived: 0,
      isArchiveUrl: 0,
      noSnapshots: 0,
      errors: 0,
      rateLimited: 0
    };
    
  // Track excluded files
  const excludedFiles: Array<{path: string, reason: string}> = [];
  const processedFiles: Array<{path: string, archived: number, skipped: number}> = [];
  
  // For detailed reporting
  const skippedDetails: Array<{file: string, line: number, url: string, reason: string}> = [];
    
    new Notice("Starting vault-wide archiving...");
    
  // Filter files based on exclusion settings
  const filesToProcess: any[] = [];
    for (const file of files) {
      const exclusionResult = this.shouldExcludeFile(file);
      if (exclusionResult.excluded) {
        excludedFiles.push({
          path: file.path,
          reason: exclusionResult.reason
        });
      } else {
        filesToProcess.push(file);
      }
    }
    
    // Process each file
    for (const file of filesToProcess) {
      try {
        const content = await this.app.vault.read(file);
        const lines = content.split('\n');
        let modified = false;
        let fileArchived = 0;
        let fileSkipped = 0;
        
        for (let i = 0; i < lines.length; i++) {
          // Skip code blocks and quotes
          if (this.isCodeBlockOrQuote(lines, i)) {
            continue;
          }
          
          const linkInfo = this.extractUrlFromLine(lines[i]);
          
          // Skip if no link found
          if (!linkInfo) {
            continue;
          }

          // Skip if line already has archive link
          if (this.lineContainsArchiveLink(lines[i])) {
            skippedLinks.alreadyArchived++;
            fileSkipped++;
            if (this.settings.detailedReporting) {
              skippedDetails.push({
                file: file.path,
                line: i + 1,
                url: linkInfo.originalUrl,
                reason: "Already has archive link"
              });
            }
            continue;
          }
          
          // Skip if the URL is an archive URL
          if (this.isArchiveUrl(linkInfo.originalUrl)) {
            skippedLinks.isArchiveUrl++;
            fileSkipped++;
            if (this.settings.detailedReporting) {
              skippedDetails.push({
                file: file.path,
                line: i + 1,
                url: linkInfo.originalUrl,
                reason: "Is an archive URL"
              });
            }
            continue;
          }
          
          try {
            const result = await this.getExistingArchive(linkInfo.originalUrl);
            
            // Check for rate limiting
            if (result.rateLimited) {
              skippedLinks.rateLimited++;
              if (this.settings.detailedReporting) {
                skippedDetails.push({
                  file: file.path,
                  line: i + 1,
                  url: linkInfo.originalUrl,
                  reason: "Rate limited by archive service"
                });
              }
              
              // If rate limited, show a notice and stop processing
              new Notice("Rate limited by archive service. Please try again later.");
              throw new Error("Rate limited by archive service");
            }
            
            if (result.foundArchive && result.archivedUrl) {
              // Extract the plain URL if archivedUrl is a markdown link
              let plainArchivedUrl = result.archivedUrl;
              const markdownMatch = result.archivedUrl.match(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/);
              if (markdownMatch) {
                plainArchivedUrl = markdownMatch[2];
              }

              let newLine;

              // Determine how to format the original link and archive link
              let originalPart, archivedPart;
              
              if (this.settings.useNakedUrls) {
                // For naked URLs mode
                originalPart = linkInfo.originalUrl;
                archivedPart = plainArchivedUrl;
              } else {
                // For markdown mode
                if (linkInfo.isNaked) {
                  let displayText;
                  try {
                    displayText = await this.extractTitleFromUrl(linkInfo.originalUrl);
                  } catch {
                    // If title scraping fails, use a more descriptive part of the URL if possible
                    try {
                      const urlObj = new URL(linkInfo.originalUrl);
                      const pathParts = urlObj.pathname.split('/').filter(part => part.length > 0);
                      
                      if (pathParts.length > 0) {
                        // Use the last meaningful path segment, replacing hyphens with spaces
                        const lastSegment = pathParts[pathParts.length - 1]
                          .replace(/\.html$|\.php$|\.aspx$/i, '')
                          .replace(/-/g, ' ');
                        displayText = lastSegment;
                      } else {
                        // Fall back to hostname
                        displayText = urlObj.hostname.replace(/^www\./, '');
                      }
                    } catch {
                      // If URL parsing fails, use the URL itself
                      displayText = linkInfo.originalUrl;
                    }
                  }
                  originalPart = `[${displayText}](${linkInfo.originalUrl})`;
                } else {
                  originalPart = `[${linkInfo.displayText}](${linkInfo.originalUrl})`;
                }
                
                // Create archive markdown link - always use plainArchivedUrl to avoid nesting
                archivedPart = this.settings.useNakedArchiveOnly ?
                  plainArchivedUrl :
                  `[archive](${plainArchivedUrl})`;
              }
              
              // Combine with the user's divider text
              const replacement = `${originalPart}${this.settings.dividerText}${archivedPart}`;
              
              // Debug logging
              
                  if (lines[i].includes(linkInfo.fullMatch)) {
                    newLine = lines[i].replace(linkInfo.fullMatch, replacement);
                    lines[i] = newLine; // MOVE THIS HERE
                    modified = true;
                    totalArchived++;
                    fileArchived++;
                } else {
                  // Fallback: if exact match fails, log and skip this link
                  skippedLinks.errors++;
                  fileSkipped++;
                  if (this.settings.detailedReporting) {
                    skippedDetails.push({
                      file: file.path,
                      line: i + 1,
                      url: linkInfo.originalUrl,
                      reason: "Could not match link in line for replacement"
                    });
                  }
                  continue;
                }


              modified = true;
              totalArchived++;
              fileArchived++;
            } else {
              skippedLinks.noSnapshots++;
              fileSkipped++;
              if (this.settings.detailedReporting) {
                skippedDetails.push({
                  file: file.path,
                  line: i + 1,
                  url: linkInfo.originalUrl,
                  reason: "No archive snapshots available"
                });
              }
              continue;
            }
          } catch (error) {
            if (this.settings.debugMode) {
    console.error(`Error archiving link in ${file.path}:`, error);
   }
            
            // Check if the error is related to rate limiting
            if (error.message && error.message.includes("Rate limited")) {
              // Stop processing all files if rate limited
              new Notice("Rate limited by archive service. Vault archiving stopped.");
              
              // Show detailed report if enabled
              if (this.settings.detailedReporting) {
                new ArchiveReportModal(this.app, {
                  archivedCount: totalArchived,
                  skippedLinks,
                  skippedDetails,
                  excludedFiles,
                  processedFiles,
                  isNote: false,
                  rateLimited: true,
                  filePath: null
                }).open();
              }
              
              return; // Exit the function
            }
            
            skippedLinks.errors++;
            fileSkipped++;
            if (this.settings.detailedReporting) {
              skippedDetails.push({
                file: file.path,
                line: i + 1,
                url: linkInfo.originalUrl,
                reason: `Error: ${error.message || "Unknown error"}`
              });
            }
          }
        }
        
        if (modified) {
          await this.app.vault.modify(file, lines.join('\n'));
        }
        
        // Add to processed files list
        processedFiles.push({
          path: file.path,
          archived: fileArchived,
          skipped: fileSkipped
        });
      } catch (error) {
        console.error(`Error processing file ${file.path}:`, error);
        
        // Check if the error is related to rate limiting
        if (error.message && error.message.includes("Rate limited")) {
          // Already handled above, just return
          return;
        }
      }
    }
    
    // Calculate total skipped
    const totalSkipped = Object.values(skippedLinks).reduce((a, b) => a + b, 0);
    
    // Show detailed report if enabled
    if (this.settings.detailedReporting) {
      new ArchiveReportModal(this.app, {
        archivedCount: totalArchived,
        skippedLinks,
        skippedDetails,
        excludedFiles,
        processedFiles,
        isNote: false,
        filePath: null
      }).open();
    } else {
      // Simple notice
      new Notice(`Vault archiving complete. Archived: ${totalArchived}, Skipped: ${totalSkipped}, Excluded: ${excludedFiles.length} files`);
    }
  }).open();
}

	async getExistingArchive(originalUrl: string, retryCount = 0): Promise<{
  foundArchive: boolean;
  archivedUrl?: string;
  snapshots?: { url: string, timestamp: string, title?: string }[];
  rateLimited?: boolean;
}> {
  console.log(`Checking for existing archives of: ${originalUrl}`);

  // Check cache first (only on first try, not retries)
  if (retryCount === 0) {
    const cachedResult = this.archiveCache.get(originalUrl);
    if (cachedResult) {
      console.log(`Using cached result for: ${originalUrl}`);
      return cachedResult;
    }
  }

  // Enforce rate limiting
  await this.rateLimiter.waitIfNeeded(this.settings.archiveSite);

  // Minimal headers to avoid detection
  const headers = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5'
  };

  const archiveBaseUrl = ARCHIVE_SITES[this.settings.archiveSite as keyof typeof ARCHIVE_SITES];
  console.log(`Using archive site: ${this.settings.archiveSite} (${archiveBaseUrl})`);
  console.log(`Archive service type: ${typeof this.settings.archiveSite}`);

  if (this.settings.archiveSite === "web.archive.org") {
    console.log("Processing with Wayback Machine");
    // Wayback Machine CDX Server API - returns multiple snapshots with filtering
    try {
      // Use CDX API to get multiple snapshots with status code filtering
      // Parameters: url, output=json, limit (respects maxSnapshots), filter=statuscode:200
      const limit = this.settings.maxSnapshots || 5;
      const checkUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(originalUrl)}&output=json&limit=${limit}&filter=statuscode:200`;
      console.log(`Checking Wayback Machine CDX API: ${checkUrl}`);

      const res = await requestUrl({
        url: checkUrl,
        headers: headers
      });

      if (res.status === 200 && res.json && Array.isArray(res.json) && res.json.length > 1) {
        // CDX returns array of arrays: [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"], ...]
        // First row is headers, subsequent rows are snapshots
        const snapshots: { url: string, timestamp: string }[] = [];

        // Skip first row (headers) and process snapshot rows
        for (let i = 1; i < res.json.length; i++) {
          const row = res.json[i];
          if (row && row.length >= 2) {
            const timestamp = row[1]; // Timestamp in YYYYMMDDhhmmss format
            const snapshotUrl = `https://web.archive.org/web/${timestamp}/${originalUrl}`;
            snapshots.push({ url: snapshotUrl, timestamp: timestamp });
          }
        }

        if (snapshots.length > 0) {
          // Sort by timestamp descending (newest first)
          snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

          console.log(`Found ${snapshots.length} Wayback Machine snapshots`);

          const result = {
            foundArchive: true,
            archivedUrl: snapshots[0].url,
            snapshots: snapshots
          };

          // Cache the result
          this.archiveCache.set(originalUrl, result);

          return result;
        }
      }

      if (this.settings.debugMode) {
        console.log(`No Wayback Machine snapshots found`);
      }
    } catch (err) {
      console.error("Error checking Wayback Machine:", err);

      // Classify the error
      const archiveError = this.classifyArchiveError(err, "Wayback Machine");

      // Show user-friendly error message
      if (archiveError.type !== ArchiveErrorType.UNKNOWN) {
        new Notice(archiveError.message);
      }

      // Check for rate limiting
      if (archiveError.type === ArchiveErrorType.RATE_LIMITED) {
        console.log("Rate limited by Wayback Machine");
        return { foundArchive: false, rateLimited: true };
      }

      // Implement retry logic with exponential backoff for transient errors
      if (retryCount < 2 && (
        archiveError.type === ArchiveErrorType.NETWORK_ERROR ||
        archiveError.type === ArchiveErrorType.SERVICE_UNAVAILABLE
      )) {
        const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s delay
        console.log(`Retrying Wayback Machine check in ${delay}ms...`);

        // Wait for the delay period
        await new Promise(resolve => setTimeout(resolve, delay));

        // Retry with incremented counter
        return this.getExistingArchive(originalUrl, retryCount + 1);
      }
    }
  } else if (this.settings.archiveSite === "ghostarchive.org") {
    console.log("Processing with Ghostarchive");
    try {
      const archiver = new GhostArchiveArchiver(this);
      if (this.settings.debugMode) {
        console.log(`getExistingArchive: calling GhostArchiveArchiver for ${originalUrl}`);
      }
      const snapshots = await archiver.getSnapshots(originalUrl);
      if (this.settings.debugMode) {
        console.log(`getExistingArchive: GhostArchiveArchiver returned ${snapshots.length} snapshots`);
      }
      
      if (snapshots.length > 0) {
        // Sort by timestamp descending
        snapshots.sort((a, b) => {
          try {
            return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
          } catch {
            return 0;
          }
        });
        
        if (this.settings.debugMode) {
          console.log(`Found ${snapshots.length} Ghostarchive snapshots`);
        }

        const result = {
          foundArchive: true,
          archivedUrl: snapshots[0].url,
          snapshots: snapshots
        };

        // Cache the result
        this.archiveCache.set(originalUrl, result);

        return result;
      } else if (this.settings.debugMode) {
        console.log(`No Ghostarchive snapshots found for URL: ${originalUrl}`);
      }
    } catch (err) {
      console.error("Error checking Ghostarchive:", err);

      // Classify the error
      const archiveError = this.classifyArchiveError(err, "GhostArchive");

      // Show user-friendly error message
      if (archiveError.type !== ArchiveErrorType.UNKNOWN) {
        new Notice(archiveError.message);
      }

      if (archiveError.type === ArchiveErrorType.RATE_LIMITED) {
        console.log("Rate limited by Ghostarchive");
        return { foundArchive: false, rateLimited: true };
      }
    }
  }
  
  console.log(`No archives found for: ${originalUrl}`);
  const result = { foundArchive: false };

  // Cache negative results too to avoid repeated failed lookups
  this.archiveCache.set(originalUrl, result);

  return result;
}

	// Classify archive service errors for better user feedback
	classifyArchiveError(err: any, serviceName: string): ArchiveError {
		// Check for rate limiting
		if (err.status === 429 ||
				(err.message && (
					err.message.toLowerCase().includes("rate limit") ||
					err.message.toLowerCase().includes("too many requests")
				))) {
			return {
				type: ArchiveErrorType.RATE_LIMITED,
				message: `${serviceName} is rate limiting requests. Please wait a moment and try again.`,
				serviceName
			};
		}

		// Check for captcha requirements (common with archive.today variants)
		if (err.status === 403 ||
				(err.text && (
					err.text.includes("captcha") ||
					err.text.includes("CAPTCHA") ||
					err.text.includes("cloudflare") ||
					err.text.includes("challenge")
				))) {
			return {
				type: ArchiveErrorType.CAPTCHA_REQUIRED,
				message: `${serviceName} requires CAPTCHA verification. This service cannot be automated.`,
				serviceName
			};
		}

		// Check for IP blocking
		if (err.status === 403 && err.message && err.message.toLowerCase().includes("forbidden")) {
			return {
				type: ArchiveErrorType.IP_BLOCKED,
				message: `${serviceName} has blocked this request. Your IP may be temporarily blocked.`,
				serviceName
			};
		}

		// Check for service unavailability
		if (err.status === 503 || err.status === 504 ||
				(err.message && (
					err.message.toLowerCase().includes("service unavailable") ||
					err.message.toLowerCase().includes("gateway timeout")
				))) {
			return {
				type: ArchiveErrorType.SERVICE_UNAVAILABLE,
				message: `${serviceName} is currently unavailable. Please try again later.`,
				serviceName
			};
		}

		// Network errors
		if (err.message && (
				err.message.toLowerCase().includes("network") ||
				err.message.toLowerCase().includes("timeout") ||
				err.message.toLowerCase().includes("econnrefused")
			)) {
			return {
				type: ArchiveErrorType.NETWORK_ERROR,
				message: `Network error connecting to ${serviceName}. Check your internet connection.`,
				serviceName
			};
		}

		// Unknown error
		return {
			type: ArchiveErrorType.UNKNOWN,
			message: `Error accessing ${serviceName}: ${err.message || 'Unknown error'}`,
			serviceName
		};
	}

// Normalize a URL for comparison
	normalizeUrl(url: string): string {
  try {
    // Create a URL object to parse the components
    const urlObj = new URL(url);
    
    // Normalize the hostname (lowercase)
    let hostname = urlObj.hostname.toLowerCase();
    
    // Normalize the path (remove trailing slash)
    let path = urlObj.pathname;
    if (path.endsWith('/') && path.length > 1) {
      path = path.slice(0, -1);
    }
    
    // Construct the normalized URL
    let normalizedUrl = hostname + path;
    if (urlObj.search) {
      normalizedUrl += urlObj.search;
    }
    
    return normalizedUrl;
  } catch (e) {
    // If URL parsing fails, return the original
    return url;
  }
}

// Score how well an archived URL matches the original URL
	scoreUrlMatch(originalUrl: string, archivedUrl: string): number {
  if (!archivedUrl) return 0;
  
  try {
    // First, check for exact URL match
    if (originalUrl === archivedUrl) {
      return 100;
    }
    
    // Normalize both URLs for comparison
    const normalizedOriginal = this.normalizeUrl(originalUrl);
    const normalizedArchived = this.normalizeUrl(archivedUrl);
    
    // Exact match after normalization gets highest score
    if (normalizedOriginal === normalizedArchived) {
      return 100;
    }
    
    // Check if the protocol differs but the rest matches
    const originalNoProtocol = normalizedOriginal.replace(/^https?:\/\//, '');
    const archivedNoProtocol = normalizedArchived.replace(/^https?:\/\//, '');
    
    if (originalNoProtocol === archivedNoProtocol) {
      return 90; // Very good match, just protocol differs
    }
    
    // Check if the archived URL is the original with www. added/removed
    const originalNoWww = originalNoProtocol.replace(/^www\./, '');
    const archivedNoWww = archivedNoProtocol.replace(/^www\./, '');
    
    if (originalNoWww === archivedNoWww) {
      return 85; // Good match, just www. prefix differs
    }
    
    // Check for trailing slash differences
    if (originalNoWww.replace(/\/$/, '') === archivedNoWww.replace(/\/$/, '')) {
      return 80; // Good match, just trailing slash differs
    }
    
    // For specific cases like news articles and blog posts, the path is important
    // We want to avoid matching just the domain
    
    try {
      const originalDomain = new URL(originalUrl).hostname.toLowerCase();
      const archivedDomain = new URL(archivedUrl).hostname.toLowerCase();
      
      // If domains match exactly but paths differ significantly
      if (originalDomain === archivedDomain) {
        // For news articles and blog posts, we typically want the exact path
        // Only give a decent score if the path is very similar
        
        const originalPath = new URL(originalUrl).pathname;
        const archivedPath = new URL(archivedUrl).pathname;
        
        // If one path is contained within the other
        if (originalPath.includes(archivedPath) || archivedPath.includes(originalPath)) {
          return 60;
        }
        
        // If paths share significant common parts
        const originalPathParts = originalPath.split('/').filter(p => p);
        const archivedPathParts = archivedPath.split('/').filter(p => p);
        
        // Check if at least 50% of path segments match
        const commonParts = originalPathParts.filter(p => archivedPathParts.includes(p));
        if (commonParts.length > 0 && 
            commonParts.length >= Math.min(originalPathParts.length, archivedPathParts.length) / 2) {
          return 50;
        }
        
        // Otherwise, it's not a good match for articles/blog posts
        return 30; // Same domain but different path - not great for articles
      }
      
      // If even the domains don't match exactly, it's a poor match
      return 10;
    } catch (e) {
      // URL parsing failed
      return 0;
    }
  } catch (e) {
    console.error("Error scoring URL match:", e);
    return 0;
  }
} 

// Helper function to validate if a URL is actually an archive URL
	isValidArchiveUrl(url: string): boolean {
  const archiveDomains = [
    'archive.ph', 'archive.today', 'archive.li', 'archive.md', 'archive.is', 'archive.vn',
    'web.archive.org', 'ghostarchive.org'
  ];
  
  try {
    const urlObj = new URL(url);
    return archiveDomains.some(domain => urlObj.hostname.includes(domain));
  } catch {
    return false;
  }
}

// Helper function to validate timestamp format
	isValidTimestamp(timestamp: string): boolean {
  if (!timestamp || timestamp === 'Unknown date') return false;
  
  // Check for common timestamp patterns
  const patterns = [
    /\d{4}-\d{2}-\d{2}/, // YYYY-MM-DD
    /\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}/, // DD Mon YYYY
    /\d{2}\/\d{2}\/\d{4}/, // MM/DD/YYYY or DD/MM/YYYY
    /\d{14}/, // Wayback timestamp format
  ];
  
  if (!patterns.some(pattern => pattern.test(timestamp))) {
    return false;
  }
  
  // Additional check for reasonable date range
  try {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    
    // Validate the date is within a reasonable range
    // Internet Archive started in 1996, but we'll allow a bit earlier
    // And we'll reject future dates beyond next year
    const currentYear = new Date().getFullYear();
    return year >= 1990 && year <= currentYear + 1 && !isNaN(date.getTime());
  } catch {
    // If date parsing fails, try to extract year from the timestamp string
    const yearMatch = timestamp.match(/\b(19\d{2}|20\d{2})\b/);
    if (yearMatch) {
      const year = parseInt(yearMatch[1]);
      const currentYear = new Date().getFullYear();
      return year >= 1990 && year <= currentYear + 1;
    }
    return false;
  }
}

	isValidArchiveSnapshot(url: string, originalUrl: string): boolean {
  // First check if it's a valid archive URL
  if (!this.isValidArchiveUrl(url)) {
    return false;
  }
  
  // Reject URLs that contain the original URL in a problematic way
  // This filters out archive.ph/https://example.com/* patterns
  if (url.includes('/http') && url.includes(new URL(originalUrl).hostname)) {
    return false;
  }
  
  // For archive.today family, check for proper snapshot format
  // Valid format is typically: archive.ph/abcd1234 or archive.ph/20220101/example.com
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(p => p);
    
    // First path segment should be either a short code or a date
    if (pathParts.length > 0) {
      const firstSegment = pathParts[0];
      
      // Valid patterns: short code (3-10 alphanumeric chars) or date (numeric)
      const isShortCode = /^[a-zA-Z0-9]{3,10}$/.test(firstSegment);
      const isDateCode = /^\d{8,14}$/.test(firstSegment);
      
      return isShortCode || isDateCode;
    }
    
    return false;
  } catch {
    return false;
  }
}

	async getGhostArchiveSnapshots(originalUrl: string): Promise<{ url: string, timestamp: string }[]> {
	  // Properly construct search URL handling all edge cases
	  let cleanUrl = originalUrl;
	  // Remove trailing slash if present
	  if (cleanUrl.endsWith('/')) {
	    cleanUrl = cleanUrl.slice(0, -1);
	  }
	  // Encode only the query parameter value
	  const searchUrl = `https://ghostarchive.org/search?term=${encodeURIComponent(cleanUrl)}`;
    console.log('Search URL:', searchUrl);
   try {
      // Browser-like headers to bypass bot detection
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://ghostarchive.org/',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      };
      
      const response = await requestUrl({
        url: searchUrl,
        headers: headers,
        method: 'GET',
        throw: false // Don't throw on non-200 status
      });
      console.log(`Response status: ${response.status}`);
      console.log(`Response headers: ${JSON.stringify(response.headers)}`);
      
      // Log response body for debugging if not 200
      if (response.status !== 200) {
        console.log(`Response body (first 500 chars): ${response.text.substring(0, 500)}...`);
      }
      
      const $ = cheerio.load(response.text);
      const snapshots: { url: string, timestamp: string }[] = [];
      let rowCount = 0;
      let validSnapshotCount = 0;
      
      console.log(`Found ${$('.result-row').length} result rows`);
      
     $('.result-row').each((_, row) => {
       rowCount++;
       const urlElem = $(row).find('td:first-child a');
       const timestampElem = $(row).find('td:nth-child(2)');
       console.log(`Processing row ${rowCount} - URL elements: ${urlElem.length}, Timestamp elements: ${timestampElem.length}`);
	      
	      if (urlElem.length && timestampElem.length) {
	        let href = urlElem.attr('href') || '';
	        // Remove trailing slash if present
	        href = href.replace(/\/$/, '');
	        
	        let url = '';
	        if (href.startsWith('/')) {
	          // Prepend domain for relative paths
	          url = `https://ghostarchive.org${href}`;
	        } else if (href.startsWith('http')) {
	          // Use absolute URLs as-is
	          url = href;
	        } else {
	          // Skip invalid hrefs
	          return;
	        }
	        
	        // Skip non-archive URLs
	        if (!url.includes('ghostarchive.org/archive/')) {
	          return;
	        }
	        
	        const timestamp = timestampElem.text().trim();
	        
	        if (this.isValidTimestamp(timestamp)) {
	          snapshots.push({ url, timestamp });
	          validSnapshotCount++;
	          console.log(`Added snapshot: ${url} with timestamp ${timestamp}`);
	        } else {
	          console.log(`Invalid timestamp: ${timestamp}`);
	        }
	      }
	    });
	    
	    if (this.settings.debugMode) {
	  console.log(`Processed ${rowCount} rows, found ${validSnapshotCount} valid snapshots`);
	 }
	    return snapshots;
	  } catch (error) {
	    console.error("Error fetching Ghost Archive snapshots:", error);
	    console.error(error.stack);
	    return [];
	  }
	}

// Add this method to score the relevance of a snapshot
	scoreSnapshotRelevance(snapshot: { url: string, timestamp: string }, originalUrl: string): number {
  let score = 0;
  
  // Valid timestamp gets points
  if (this.isValidTimestamp(snapshot.timestamp)) {
    score += 30;
    
    // Recent timestamps (within last 2 years) get bonus points
    try {
      const snapshotDate = new Date(snapshot.timestamp);
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
      
      if (snapshotDate > twoYearsAgo) {
        score += 20;
      }
    } catch {}
  }
  
  // URL format scoring
  try {
    const urlObj = new URL(snapshot.url);
    const pathParts = urlObj.pathname.split('/').filter(p => p);
    
    // Preferred format: archive.ph/abcd1234
    if (pathParts.length === 1 && /^[a-zA-Z0-9]{3,10}$/.test(pathParts[0])) {
      score += 25;
    }
    
    // Also good: archive.ph/20220101/example.com
    if (pathParts.length >= 2 && /^\d{8,14}$/.test(pathParts[0])) {
      score += 20;
      
      // Extra points if the path contains the original domain
      try {
        const originalDomain = new URL(originalUrl).hostname.replace('www.', '');
        if (pathParts[1].includes(originalDomain)) {
          score += 15;
        }
      } catch {}
    }
  } catch {}
  
  return score;
}

// Add this helper method if it's not already defined
	extractArchivedUrl(href: string, linkText: string, contextText: string): string {
  // For archive.today snapshots, the URL is often in the link text or nearby
  
  // Method 1: Check if the link text is a URL
  if (linkText && linkText.match(/^https?:\/\//)) {
    return linkText;
  }
  
  // Method 2: Look for URL patterns in the context text
  const urlMatch = contextText.match(/https?:\/\/[^\s"'<>()[\]{}]+/);
  if (urlMatch) {
    return urlMatch[0];
  }
  
  // Method 3: For archive.today format, extract from the snapshot ID
  // Example: /abc123 might be a snapshot of http://example.com
  if (href && href.startsWith('/')) {
    // This is more of a guess, but we can check if the snapshot page loads
    // and extract the URL from there in a real implementation
    return ""; // Placeholder
  }
  
  return "";
}

	// Fixed snapshot modal to properly resolve the promise
	async showSnapshotModal(snapshots: { url: string, timestamp?: string, title?: string }[]): Promise<string | null> {
  return new Promise((resolve) => {
    new ArchivePickerModal(this.app, this, snapshots, "", resolve).open();
  });
  }

  // Add this helper method to the LinkArchiverPlugin class
 lineContainsArchiveLink(line: string): boolean {
   // More robust check: look for patterns that indicate an archive link structure
   // Pattern 1: [text](url) divider [archive](archive-url) or [text](url) divider archive-url
   // Pattern 2: url divider [archive](archive-url) or url divider archive-url
   
   const archiveDomains = [
     'archive.ph', 'archive.today', 'archive.li', 'archive.md', 'archive.is', 'archive.vn',
     'web.archive.org', 'ghostarchive.org'
   ];
    
    const dividers = [
      this.settings.dividerText,
      " | archive: ",
      " | ",
      " 📚 ",
      " (archived: "
    ];
    
    // Check for each divider pattern
    for (const divider of dividers) {
      const parts = line.split(divider);
      if (parts.length >= 2) {
        // Check if the second part (after divider) contains an archive domain
        const afterDivider = parts.slice(1).join(divider);
        const hasArchiveInSecondPart = archiveDomains.some(domain => afterDivider.includes(domain));
        
        if (hasArchiveInSecondPart) {
          return true;
        }
      }
    }
    
    return false;
  }

  // Add this helper method to check if a URL is an archive URL
  isArchiveUrl(url: string): boolean {
    const archiveDomains = [
      'archive.ph', 'archive.today', 'archive.li', 'archive.md', 'archive.is', 'archive.vn',
      'web.archive.org', 'ghostarchive.org'
    ];
    
    try {
      const urlObj = new URL(url);
      return archiveDomains.some(domain => urlObj.hostname.includes(domain));
    } catch {
      return false;
    }
  }
  
  // Helper method to check if a file should be excluded from batch processing
  shouldExcludeFile(file: any): { excluded: boolean; reason: string } {
    // Check if the file is in an excluded folder
    if (this.settings.excludeFolders.length > 0) {
      for (const folder of this.settings.excludeFolders) {
        if (file.path.startsWith(folder + '/') || file.path === folder) {
          return { excluded: true, reason: `In excluded folder: ${folder}` };
        }
      }
    }
    
    // Check if the file has excluded tags (both inline and in frontmatter)
    if (this.settings.excludeFilesWithTags.length > 0) {
      try {
        const cache = this.app.metadataCache.getFileCache(file);
        
        // Check inline tags
        if (cache && cache.tags) {
          for (const tagObj of cache.tags) {
            const tag = tagObj.tag;
            if (this.settings.excludeFilesWithTags.includes(tag)) {
              return { excluded: true, reason: `Has excluded tag: ${tag}` };
            }
          }
        }
        
        // Check frontmatter tags
        if (cache && cache.frontmatter) {
          const frontmatterTags = cache.frontmatter.tags;
          if (frontmatterTags) {
            // Handle both array and string formats
            const tagsArray = Array.isArray(frontmatterTags)
              ? frontmatterTags
              : frontmatterTags.split(',').map((t: string) => t.trim());
            
            for (const tag of tagsArray) {
              const formattedTag = tag.startsWith('#') ? tag : `#${tag}`;
              if (this.settings.excludeFilesWithTags.includes(formattedTag)) {
                return { excluded: true, reason: `Has excluded frontmatter tag: ${formattedTag}` };
              }
            }
          }
        }
      } catch (error) {
        console.error(`Error checking tags for ${file.path}:`, error);
      }
    }
    
    // Check if inverted exclusion is enabled and this file should be included
    if (this.settings.useInvertedExclusion) {
      let shouldInclude = false;
      
      // Check if file is in a targeted folder
      if (this.settings.targetFolders.length > 0) {
        for (const folder of this.settings.targetFolders) {
          if (file.path.startsWith(folder + '/') || file.path === folder) {
            shouldInclude = true;
            break;
          }
        }
      }
      
      // Check if file has a targeted tag
      if (!shouldInclude && this.settings.targetFilesWithTags.length > 0) {
        try {
          const cache = this.app.metadataCache.getFileCache(file);
          
          // Check inline tags
          if (cache && cache.tags) {
            for (const tagObj of cache.tags) {
              const tag = tagObj.tag;
              if (this.settings.targetFilesWithTags.includes(tag)) {
                shouldInclude = true;
                break;
              }
            }
          }
          
          // Check frontmatter tags
          if (!shouldInclude && cache && cache.frontmatter) {
            const frontmatterTags = cache.frontmatter.tags;
            if (frontmatterTags) {
              const tagsArray = Array.isArray(frontmatterTags)
                ? frontmatterTags
                : frontmatterTags.split(',').map((t: string) => t.trim());
              
              for (const tag of tagsArray) {
                const formattedTag = tag.startsWith('#') ? tag : `#${tag}`;
                if (this.settings.targetFilesWithTags.includes(formattedTag)) {
                  shouldInclude = true;
                  break;
                }
              }
            }
          }
        } catch (error) {
          console.error(`Error checking tags for ${file.path}:`, error);
        }
      }
      
      // If targeting is enabled but this file doesn't match any targets, exclude it
      if (this.settings.targetFolders.length > 0 || this.settings.targetFilesWithTags.length > 0) {
        if (!shouldInclude) {
          return { excluded: true, reason: 'Not in targeted folders or tags' };
        }
      }
    }
    
    return { excluded: false, reason: '' };
  }
  
 showRemoveArchiveLinksDialog() {
  new RemoveArchiveLinksModal(this.app, this).open();
}

// Method to archive links in targeted files only
async archiveTargetedFiles() {
  // Temporarily enable inverted exclusion
  const previousSetting = this.settings.useInvertedExclusion;
  this.settings.useInvertedExclusion = true;
  
  // Show confirmation dialog with target information
  let targetInfo = "";
  if (this.settings.targetFolders.length > 0) {
    targetInfo += `Folders: ${this.settings.targetFolders.join(", ")}\n`;
  }
  if (this.settings.targetFilesWithTags.length > 0) {
    targetInfo += `Tags: ${this.settings.targetFilesWithTags.join(", ")}`;
  }
  
  if (!targetInfo) {
    new Notice("No targets configured. Please set target folders or tags in settings.");
    this.settings.useInvertedExclusion = previousSetting;
    return;
  }
  
  new TargetedArchiveModal(this.app, targetInfo, async () => {
    await this.archiveAllLinksInVault();
    // Restore previous setting
    this.settings.useInvertedExclusion = previousSetting;
  }, () => {
    // Restore previous setting on cancel
    this.settings.useInvertedExclusion = previousSetting;
  }).open();
}

	async removeArchiveLinksFromCurrentNote() {
  const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
  if (!activeLeaf) {
    new Notice("No active markdown editor found.");
    return;
  }
  
  const editor = activeLeaf.editor;
  const content = editor.getValue();
  const lines = content.split('\n');
  let modifiedCount = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Look for lines with archive links
    if (this.lineContainsArchiveLink(line)) {
      // Extract the original link without the archive part
      const originalLink = this.extractOriginalLinkFromArchiveLine(line);
      if (originalLink) {
        lines[i] = originalLink;
        modifiedCount++;
      }
    }
  }
  
  if (modifiedCount > 0) {
    editor.setValue(lines.join('\n'));
    new Notice(`Removed ${modifiedCount} archive links from the current note.`);
  } else {
    new Notice("No archive links found in the current note.");
  }
}

	async removeArchiveLinksFromVault() {
  const files = this.app.vault.getMarkdownFiles();
  let totalModified = 0;
  let filesModified = 0;
  
  new Notice("Starting to remove archive links from vault...");
  
  for (const file of files) {
    try {
      const content = await this.app.vault.read(file);
      const lines = content.split('\n');
      let modified = false;
      let fileModifiedCount = 0;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Look for lines with archive links
        if (this.lineContainsArchiveLink(line)) {
          // Extract the original link without the archive part
          const originalLink = this.extractOriginalLinkFromArchiveLine(line);
          if (originalLink) {
            lines[i] = originalLink;
            modified = true;
            fileModifiedCount++;
          }
        }
      }
      
      if (modified) {
        await this.app.vault.modify(file, lines.join('\n'));
        filesModified++;
        totalModified += fileModifiedCount;
      }
    } catch (error) {
      console.error(`Error processing file ${file.path}:`, error);
    }
  }
  
  new Notice(`Removed ${totalModified} archive links from ${filesModified} files.`);
}

  // Helper method to extract the original link from a line with an archive link
 extractOriginalLinkFromArchiveLine(line: string): string | null {
    // Match patterns like:
    // 1. [Title](url) | [archive](archive-url)
    // 2. [Title](url) | archive-url
    // 3. url | [archive](archive-url)
    // 4. url | archive-url
    
    // Look for the divider text (or common alternatives if user has customized it)
    const dividers = [
      this.settings.dividerText,
      " | archive: ",
      " | ",
      " 📚 ",
      " (archived: "
    ];
    
    for (const divider of dividers) {
      const parts = line.split(divider);
      if (parts.length >= 2) {
        // Return just the first part (original link)
        return parts[0].trim();
      }
      
    }
    
    // If no standard divider found, try regex patterns
    // Pattern for markdown link followed by archive
    const markdownPattern = /(\[[^\]]+\]\([^)]+\))\s*(?:\||📚|→|—|->|=>)\s*(?:\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s]+)/;
    const markdownMatch = line.match(markdownPattern);
    if (markdownMatch) {
      return markdownMatch[1];
    }
    
    // Pattern for naked URL followed by archive
    const nakedPattern = /(https?:\/\/[^\s|]+)\s*(?:\||📚|→|—|->|=>)\s*(?:\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s]+)/;
    const nakedMatch = line.match(nakedPattern);
    if (nakedMatch) {
      return nakedMatch[1];
    }
    
    return null;
  }
}

class ArchiveNoteModal extends Modal {
  onConfirm: () => void;
  
  constructor(app: App, onConfirm: () => void) {
    super(app);
    this.onConfirm = onConfirm;
  }
  
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Archive all links in note" });
    contentEl.createEl("p", { text: "This will add archive links to all URLs in the current note." });
    
    const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(buttonContainer)
      .setButtonText("Continue")
      .setCta()
      .onClick(() => {
        this.onConfirm();
        this.close();
      });
    
    new ButtonComponent(buttonContainer)
      .setButtonText("Cancel")
      .onClick(() => {
        this.close();
      });
  }
  
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class ArchivePromptModal extends Modal {
	originalUrl: string;
	onSubmit: (archivedUrl: string | null) => void;
	plugin: LinkArchiverPlugin;

	constructor(app: App, originalUrl: string, onSubmit: (archivedUrl: string | null) => void, plugin: LinkArchiverPlugin) {
		super(app);
		this.originalUrl = originalUrl;
		this.onSubmit = onSubmit;
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "No existing archive snapshot found" });
		contentEl.createEl("p", { text: `No archived version was found for: ${this.originalUrl}` });
		contentEl.createEl("p", { text: "Would you like to create a new snapshot?" });

		const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
		
		new ButtonComponent(buttonContainer)
			.setButtonText("Create Snapshot")
			.setCta()
			.onClick(() => {
				// Get the correct archive creation URL based on selected site
				let archiveCreateUrl: string;

				if (this.plugin.settings.archiveSite === "web.archive.org") {
					archiveCreateUrl = `https://web.archive.org/save/${this.originalUrl}`;
				} else if (this.plugin.settings.archiveSite === "ghostarchive.org") {
					archiveCreateUrl = `https://ghostarchive.org/archive/${encodeURIComponent(this.originalUrl)}`;
				} else {
					// Fallback to Wayback Machine
					archiveCreateUrl = `https://web.archive.org/save/${this.originalUrl}`;
				}

				// Open the archive creation URL in browser
				window.open(archiveCreateUrl, '_blank');

				// Show input for the user to paste the archived URL
				this.showArchiveInputStep();
			});

		new ButtonComponent(buttonContainer)
			.setButtonText("Cancel")
			.onClick(() => {
				this.onSubmit(null);
				this.close();
			});
	}

	showArchiveInputStep() {
		const { contentEl } = this;
		contentEl.empty();
		
		contentEl.createEl("h2", { text: "Enter archived URL" });
		contentEl.createEl("p", { text: "After the snapshot is created, paste the archived URL here:" });

		const inputEl = contentEl.createEl("input", { type: "text", placeholder: "https://web.archive.org/web/... or https://ghostarchive.org/..." });
		inputEl.style.width = "100%";
		inputEl.style.marginBottom = "1rem";

		const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
		
		const saveButton = new ButtonComponent(buttonContainer)
			.setButtonText("Save")
			.setCta()
			.onClick(() => {
				const archivedUrl = inputEl.value.trim();
				if (archivedUrl && archivedUrl.startsWith('http')) {
					this.onSubmit(archivedUrl);
					this.close();
				} else {
					new Notice("Please enter a valid URL");
				}
			});

		new ButtonComponent(buttonContainer)
			.setButtonText("Cancel")
			.onClick(() => {
				this.onSubmit(null);
				this.close();
			});

		inputEl.focus();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class ArchivePickerModal extends Modal {
	plugin: LinkArchiverPlugin;
	snapshots: { url: string; timestamp?: string; title?: string }[];
	originalUrl: string;
	onSubmit: (chosenUrl: string | null) => void;
	selectedUrl: string | null = null;

	constructor(app: App, plugin: LinkArchiverPlugin, snapshots: { url: string; timestamp?: string; title?: string }[], originalUrl: string, onSubmit: (chosenUrl: string | null) => void) {
		super(app);
		this.plugin = plugin;
		this.snapshots = snapshots;
		this.originalUrl = originalUrl;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Choose an archive snapshot" });

		const listContainer = contentEl.createDiv({ cls: "archive-picker-list" });

		this.snapshots.forEach((snapshot) => {
			const linkEl = listContainer.createEl("div", { cls: "archive-picker-item" });
			
			// Display title if available, otherwise fallback to URL
			const displayText = snapshot.title || (snapshot.timestamp ? `${snapshot.timestamp} — ${snapshot.url}` : snapshot.url);
			linkEl.textContent = displayText;

			linkEl.style.cursor = "pointer";
			linkEl.style.padding = "0.5em";
			linkEl.style.border = "1px solid #ccc";
			linkEl.style.marginBottom = "0.5em";
			linkEl.style.borderRadius = "5px";

			linkEl.onClickEvent(() => {
				this.selectedUrl = snapshot.url;

				// Highlight selection visually
				listContainer.querySelectorAll('.archive-picker-item').forEach(el => {
					(el as HTMLElement).style.backgroundColor = "";
				});
				linkEl.style.backgroundColor = "#d0ebff"; // highlight color
			});
		});

		// Confirm and cancel buttons
		const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });

		new ButtonComponent(buttonContainer)
			.setButtonText("Insert Snapshot")
			.setCta()
			.onClick(() => {
				if (this.selectedUrl) {
					this.onSubmit(this.selectedUrl);
					this.close();
				} else {
					new Notice("Please select a snapshot.");
				}
			});

		new ButtonComponent(buttonContainer)
			.setButtonText("Cancel")
			.onClick(() => {
				this.onSubmit(null);
				this.close();
			});
	}

	onClose() {
		this.contentEl.empty();
	}
}

class ArchiveVaultModal extends Modal {
	onConfirm: () => void;

	constructor(app: App, onConfirm: () => void) {
		super(app);
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Archive all links in vault" });
		contentEl.createEl("p", { text: "This will process every markdown file in your vault and add links of the latest snapshot where existing snapshots are found." });
		contentEl.createEl("p", { text: "This action will modify your files! Make sure you have a backup!" });

		const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
		
		new ButtonComponent(buttonContainer)
			.setButtonText("Continue")
			.setWarning()
			.onClick(() => {
				this.onConfirm();
				this.close();
			});

		new ButtonComponent(buttonContainer)
			.setButtonText("Cancel")
			.onClick(() => {
				this.close();
			});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class TargetedArchiveModal extends Modal {
	onConfirm: () => void;
	onCancel: () => void;
	targetInfo: string;

	constructor(app: App, targetInfo: string, onConfirm: () => void, onCancel: () => void) {
		super(app);
		this.targetInfo = targetInfo;
		this.onConfirm = onConfirm;
		this.onCancel = onCancel;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Archive links in targeted files only" });
		contentEl.createEl("p", { text: "This will process only files matching the following criteria:" });
		
		const infoEl = contentEl.createEl("div", { cls: "targeted-info" });
		infoEl.innerHTML = this.targetInfo.replace(/\n/g, "<br>");
		
		contentEl.createEl("p", { text: "This action will modify your files! Make sure you have a backup!" });

		const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
		
		new ButtonComponent(buttonContainer)
			.setButtonText("Continue")
			.setWarning()
			.onClick(() => {
				this.onConfirm();
				this.close();
			});

		new ButtonComponent(buttonContainer)
			.setButtonText("Cancel")
			.onClick(() => {
				this.onCancel();
				this.close();
			});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class RemoveArchiveLinksModal extends Modal {
  plugin: LinkArchiverPlugin;
  
  constructor(app: App, plugin: LinkArchiverPlugin) {
    super(app);
    this.plugin = plugin;
  }
  
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Remove Archive Links" });
    contentEl.createEl("p", { text: "This will remove all archive links added by the plugin." });
    contentEl.createEl("p", { text: "Choose where to remove archive links from:", cls: "warning" });
    
    const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
    
    new ButtonComponent(buttonContainer)
      .setButtonText("Current Note")
      .setCta()
      .onClick(() => {
        this.close();
        this.plugin.removeArchiveLinksFromCurrentNote();
      });
    
    new ButtonComponent(buttonContainer)
      .setButtonText("Entire Vault")
      .setWarning()
      .onClick(() => {
        this.close();
        this.plugin.removeArchiveLinksFromVault();
      });
    
    new ButtonComponent(buttonContainer)
      .setButtonText("Cancel")
      .onClick(() => {
        this.close();
      });
  }
  
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// Modal for displaying detailed archive reports
class ArchiveReportModal extends Modal {
  report: {
    archivedCount: number;
    targetedFolders?: string[];
    targetedTags?: string[];
    skippedLinks: {
      alreadyArchived: number;
      isArchiveUrl: number;
      noSnapshots: number;
      errors: number;
      rateLimited: number;
    };
    skippedDetails: Array<{
      file?: string;
      line: number;
      url: string;
      reason: string;
    }>;
    excludedFiles?: Array<{
      path: string;
      reason: string;
    }>;
    processedFiles?: Array<{
      path: string;
      archived: number;
      skipped: number;
    }>;
    isNote: boolean;
    rateLimited?: boolean;
    filePath?: string;
  };

  constructor(app: App, report: any) {
    super(app);
    this.report = report;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    
    // Title
    contentEl.createEl("h2", { text: this.report.isNote ? "Note Archiving Report" : "Vault Archiving Report" });
    
    // Summary section
    const summaryEl = contentEl.createDiv({ cls: "archive-report-summary" });
    summaryEl.createEl("h3", { text: "Summary" });
    
    const summaryList = summaryEl.createEl("ul");
    summaryList.createEl("li", { text: `Links archived: ${this.report.archivedCount}` });
    
    const totalSkipped = Object.values(this.report.skippedLinks).reduce((a, b) => a + b, 0);
    summaryList.createEl("li", { text: `Links skipped: ${totalSkipped}` });

    if (this.report.excludedFiles && this.report.excludedFiles.length > 0) {
      summaryList.createEl("li", { text: `Files excluded: ${this.report.excludedFiles.length}` });
    }
    
    if (this.report.rateLimited) {
      const warningEl = summaryEl.createEl("div", { cls: "archive-report-warning" });
      warningEl.createEl("p", {
        text: "⚠️ Process was interrupted due to rate limiting by the archive service. Try again later."
      });
    }
    
    // Details section
    if (this.report.skippedDetails.length > 0) {
      const detailsEl = contentEl.createDiv({ cls: "archive-report-details" });
      detailsEl.createEl("h3", { text: "Skipped Links" });
      
      // Show targeted folders/tags at the top
      if (this.report.targetedFolders?.length) {
        detailsEl.createEl("p", {
          text: `Targeted folder: ${this.report.targetedFolders.join(', ')}`
        });
      }
      if (this.report.targetedTags?.length) {
        detailsEl.createEl("p", {
          text: `Targeted tags: ${this.report.targetedTags.join(', ')}`
        });
      }

      // Group skipped details by file
      const skippedByFile: Record<string, Array<typeof this.report.skippedDetails[0]>> = {};
      this.report.skippedDetails.forEach(detail => {
        const file = detail.file || this.report.filePath || 'Unknown file';
        if (!skippedByFile[file]) {
          skippedByFile[file] = [];
        }
        skippedByFile[file].push(detail);
      });

      // Show skipped details grouped by file
      for (const [file, details] of Object.entries(skippedByFile)) {
        // Create link to the file
        const fileLink = detailsEl.createEl('a', {
          href: file,
          text: file,
          cls: 'internal-link'
        });
        fileLink.addEventListener('click', (evt) => {
          evt.preventDefault();
          this.app.workspace.openLinkText(file, '/', evt.ctrlKey || evt.metaKey);
        });

        // Create list of skipped URLs for this file
        const detailsList = detailsEl.createEl("ul");
        details.forEach(detail => {
          detailsList.createEl("li", {
            text: `Line ${detail.line}: ${detail.url} - ${detail.reason}`
          });
        });
      }
    }
    
    // Excluded files section
    if (this.report.excludedFiles && this.report.excludedFiles.length > 0) {
      const excludedEl = contentEl.createDiv({ cls: "archive-report-excluded" });
      excludedEl.createEl("h3", { text: "Excluded Files" });
      
      const excludedList = excludedEl.createEl("ul");
      this.report.excludedFiles.forEach(file => {
        excludedList.createEl("li", { text: `${file.path} - ${file.reason}` });
      });
    }
    
    // Action buttons
    const buttonContainer = contentEl.createDiv({ cls: "archive-report-actions" });
    
    // Copy to clipboard button
    new ButtonComponent(buttonContainer)
      .setButtonText("Copy to Clipboard")
      .onClick(() => {
        const reportText = this.generateReportText();
        navigator.clipboard.writeText(reportText).then(() => {
          new Notice("Report copied to clipboard");
        }, () => {
          new Notice("Failed to copy report to clipboard");
        });
      });
    
    // Create note button
    new ButtonComponent(buttonContainer)
      .setButtonText("Create Report Note")
      .onClick(() => {
        this.createReportNote();
      });
    
    // Close button
    new ButtonComponent(buttonContainer)
      .setButtonText("Close")
      .onClick(() => {
        this.close();
      });
  }
  
generateReportText(): string {
  const lines: string[] = [];
  
  // Title
  lines.push(`# ${this.report.isNote ? "Note" : "Vault"} Archiving Report`);
  lines.push("---");
  lines.push("");
  
  // Summary
  lines.push("## Summary");
  lines.push(`- Links archived: ${this.report.archivedCount}`);
  
  const totalSkipped = Object.values(this.report.skippedLinks).reduce((a, b) => a + b, 0);
  lines.push(`- Links skipped: ${totalSkipped}`);
  
  if (this.report.excludedFiles && this.report.excludedFiles.length > 0) {
    lines.push(`- Files excluded: ${this.report.excludedFiles.length}`);
  }
  
  if (this.report.rateLimited) {
    lines.push("");
    lines.push("> ⚠️ Process was interrupted due to rate limiting by the archive service. Try again later.");
  }
  
  lines.push("");
  lines.push("---");
  lines.push("");
  
  // Skipped links breakdown
  lines.push("## Skipped Links Breakdown");
  lines.push(`- Already archived: ${this.report.skippedLinks.alreadyArchived}`);
  lines.push(`- Archive URLs: ${this.report.skippedLinks.isArchiveUrl}`);
  lines.push(`- No snapshots available: ${this.report.skippedLinks.noSnapshots}`);
  lines.push(`- Errors: ${this.report.skippedLinks.errors}`);
  lines.push(`- Rate limited: ${this.report.skippedLinks.rateLimited}`);
  
  lines.push("");
  lines.push("---");
  lines.push("");
  
  // Details
  if (this.report.skippedDetails.length > 0) {
    lines.push("## Skipped Links Details");
    
    // Add targeting information if available
    if (!this.report.isNote) {
      // For vault reports, we might want to show what was targeted
      // This would need to be passed in the report object
      if (this.report.targetedFolders) {
        lines.push(`Targeted folder: ${this.report.targetedFolders.join(", ")}`);
      }
      if (this.report.targetedTags) {
        lines.push(`Targeted Tags: ${this.report.targetedTags.map(tag => `#${tag}`).join(", ")}`);
      }
    }
    
    lines.push("");
    
    // Group skipped details by file
    const groupedDetails = new Map<string, Array<{line: number, url: string, reason: string}>>();
    
    for (const detail of this.report.skippedDetails) {
      // Determine the file name to use for grouping - ensure it's always a string
      const fileName = detail.file || (this.report.isNote ? this.report.filePath : 'Unknown file') || 'Unknown file';
      
      let detailsArray = groupedDetails.get(fileName);
      if (!detailsArray) {
        detailsArray = [];
        groupedDetails.set(fileName, detailsArray);
      }
      detailsArray.push(detail);
    }

    // Output the skipped details
    for (const [fileName, details] of groupedDetails.entries()) {
      // Format file name as Markdown link
      const formattedFileName = fileName === 'Unknown file' ?
        fileName :
        `[[${fileName}]]`;
      
      lines.push(`### ${formattedFileName}`);
      
      for (const detail of details) {
        // Output URL without brackets
        lines.push(`- Line ${detail.line}: ${detail.url} - ${detail.reason}`);
      }
      lines.push(""); // Add empty line between files
    }
  }
  
  // Excluded files
  if (this.report.excludedFiles && this.report.excludedFiles.length > 0) {
    lines.push("## Excluded Files");
    
    this.report.excludedFiles.forEach(file => {
      lines.push(`- ${file.path} - ${file.reason}`);
    });
    
    lines.push("");
    lines.push("---");
  }
  
  return lines.join("\n");
}
  async createReportNote() {
    const reportText = this.generateReportText();
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    
    let fileName: string;
    if (this.report.isNote && this.report.filePath) {
      // Extract note name from file path
      const noteName = this.report.filePath
        .split('/').pop()!  // Get last part of path
        .replace(/\.md$/, ''); // Remove .md extension
      fileName = `Note Archive Report - ${noteName} - ${year}-${month}-${day}.md`;
    } else {
      fileName = `Vault Archive Report - ${year}-${month}-${day}.md`;
    }
    
    
    try {
      let file: TFile;
      
      // Check if file already exists
      const existingFile = this.app.vault.getAbstractFileByPath(fileName);
      if (existingFile instanceof TFile) {
        // If file exists, modify it
        await this.app.vault.modify(existingFile, reportText);
        file = existingFile;
        new Notice(`Report note updated: ${fileName}`);
      } else {
        // If file doesn't exist, create it
        file = await this.app.vault.create(fileName, reportText);
        new Notice(`Report note created: ${fileName}`);
      }
      
      // Open the note
      const leaf = this.app.workspace.getLeaf(false);
      if (file) {
        await leaf.openFile(file);
      }
      
      this.close();
    } catch (error) {
      console.error("Error creating/updating report note:", error);
      new Notice("Failed to create/update report note");
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// GhostArchiveArchiver class implementation
class GhostArchiveArchiver {
	constructor(private plugin: LinkArchiverPlugin) {}

	async getSnapshots(originalUrl: string): Promise<{ url: string, timestamp: string, title?: string }[]> {
		// Extract video ID from YouTube URLs first
		let videoId: string | null = null;
		const isYouTube = originalUrl.includes('youtube.com') || originalUrl.includes('youtu.be');

		if (isYouTube) {
			const youtubeMatch = originalUrl.match(/[?&]v=([^&]+)/) ||
								originalUrl.match(/youtu\.be\/([^?&]+)/) ||
								originalUrl.match(/youtube\.com\/embed\/([^?&]+)/) ||
								originalUrl.match(/youtube\.com\/v\/([^?&]+)/);
			if (youtubeMatch && youtubeMatch[1]) {
				videoId = youtubeMatch[1];
				console.log(`GhostArchiveArchiver: extracted YouTube video ID: ${videoId}`);

				// For YouTube, try direct URL construction first (avoids search page blocking)
				const directResult = await this.getYouTubeArchiveDirect(videoId);
				if (directResult.length > 0) {
					return directResult;
				}
				console.log(`GhostArchiveArchiver: direct URL check failed, trying search fallback`);
			} else {
				console.log(`GhostArchiveArchiver: could not extract video ID from YouTube URL`);
				return [];
			}
		}

		// For non-YouTube URLs or YouTube fallback, use search approach
		let searchTerm = isYouTube && videoId ? videoId : originalUrl.replace(/^https?:\/\//, '');
		if (searchTerm.endsWith('/')) {
			searchTerm = searchTerm.slice(0, -1);
		}

		const searchUrl = `https://ghostarchive.org/search?term=${encodeURIComponent(searchTerm)}`;
		console.log(`GhostArchiveArchiver: constructed search URL: ${searchUrl}`);
		
		try {
			const headers = {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
				'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
				'Accept-Language': 'en-US,en;q=0.9',
				'Referer': 'https://ghostarchive.org/',
				'DNT': '1',
				'Connection': 'keep-alive',
				'Upgrade-Insecure-Requests': '1'
			};
			
			const response = await requestUrl({
				url: searchUrl,
				headers: headers,
				method: 'GET',
				throw: false
			});
			
			if (response.status !== 200) {
				console.log(`GhostArchiveArchiver: HTTP response status ${response.status}`);
				return [];
			}
			console.log(`GhostArchiveArchiver: HTTP response status ${response.status}`);
			
			const $ = cheerio.load(response.text);
			const snapshots: { url: string, timestamp: string, title?: string }[] = [];
			
			// Find all result rows in the search results table
			const rows = $('.result-row');
			console.log(`GhostArchiveArchiver: found ${rows.length} result rows`);
			
			rows.each((_, row) => {
				const $row = $(row);
				const $urlCell = $row.find('td:first-child');
				const $timestampCell = $row.find('td:nth-child(2)');
				
				// Extract URL from the first cell
				const $link = $urlCell.find('a');
				let href = $link.attr('href') || '';
				const linkText = $link.text().trim();
				console.log(`GhostArchiveArchiver: processing result row with href: ${href}, linkText: ${linkText}`);
				
				// Skip if href is empty
				if (!href) {
					console.log(`GhostArchiveArchiver: skipping row with empty href`);
					return;
				}
				
				// Extract timestamp from the second cell
				let timestamp = $timestampCell.text().trim();
				console.log(`GhostArchiveArchiver: extracted timestamp: ${timestamp}`);
				
				// Clean up any extra whitespace or HTML entities
				timestamp = timestamp.replace(/\s+/g, ' ').replace(/&nbsp;/g, ' ');
				console.log(`GhostArchiveArchiver: cleaned timestamp: ${timestamp}`);
				
				// If no timestamp found, use a default
				if (!timestamp) {
					timestamp = 'Unknown date';
					console.log(`GhostArchiveArchiver: no timestamp found, using default`);
				}
				
				// Normalize the href to a full URL
				let fullUrl = href;
				
				// If href is relative, make it absolute
				if (href.startsWith('/')) {
					fullUrl = `https://ghostarchive.org${href}`;
				} else if (!href.startsWith('http')) {
					// If it's just an ID, construct the full URL
					const isVideo = href.includes('/varchive/') || (videoId && href === videoId);
					const baseUrl = isVideo ? 'https://ghostarchive.org/varchive/' : 'https://ghostarchive.org/archive/';
					fullUrl = `${baseUrl}${href.replace(/^\/*(archive|varchive)\//, '')}`;
				}
				
				// For YouTube videos, verify the URL contains the video ID
				if (videoId) {
					if (!fullUrl.includes(videoId)) {
						console.log(`GhostArchiveArchiver: skipping link that doesn't match video ID ${videoId}: ${fullUrl}`);
						return;
					}
				}
				
				// Extract title from link text or URL
				let title: string | undefined;
				if (linkText && !linkText.startsWith('http') && linkText.length > 0) {
					title = linkText;
				}
				
				console.log(`GhostArchiveArchiver: found valid snapshot at ${fullUrl} with timestamp ${timestamp}${title ? `, title: ${title}` : ''}`);
				snapshots.push({ url: fullUrl, timestamp, title });
			});
			
			return snapshots;
		} catch (error) {
			console.error("Error fetching Ghost Archive snapshots:", error);
			return [];
		}
	}

	private isValidGhostTimestamp(timestamp: string): boolean {
		// Ghostarchive timestamps look like: "Mon, 02 Jun 2025 03:11:50 GMT"
		// We'll validate by checking for a date string with at least 3 parts
		return timestamp.trim().split(/\s+/).length >= 3;
	}

	// Direct URL construction for YouTube videos (bypasses search page blocking)
	private async getYouTubeArchiveDirect(videoId: string): Promise<{ url: string, timestamp: string }[]> {
		console.log(`GhostArchiveArchiver: attempting direct URL construction for video ID: ${videoId}`);

		// GhostArchive uses /varchive/ for YouTube videos
		const archiveUrl = `https://ghostarchive.org/varchive/${videoId}`;

		try {
			// Try to access the archive URL directly to verify it exists
			const response = await requestUrl({
				url: archiveUrl,
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
				},
				method: 'GET',
				throw: false
			});

			console.log(`GhostArchiveArchiver: direct URL check returned status ${response.status}`);

			// If we get a 200, the archive exists
			if (response.status === 200) {
				// Try to extract timestamp from the page
				let timestamp = 'Unknown date';

				try {
					const $ = cheerio.load(response.text);

					// Look for timestamp in common locations
					const timestampSelectors = [
						'.archive-timestamp',
						'.timestamp',
						'.date',
						'time[datetime]',
						'meta[property="article:published_time"]'
					];

					for (const selector of timestampSelectors) {
						const element = $(selector).first();
						if (element.length) {
							timestamp = element.attr('datetime') || element.text().trim();
							if (timestamp) break;
						}
					}

					// If still no timestamp, look for date-like text
					if (timestamp === 'Unknown date') {
						const pageText = $('body').text();
						const dateMatch = pageText.match(/\w{3},\s+\d{2}\s+\w{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT/) ||
										 pageText.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
						if (dateMatch) {
							timestamp = dateMatch[0];
						}
					}
				} catch (parseError) {
					console.log(`GhostArchiveArchiver: could not extract timestamp: ${parseError}`);
				}

				console.log(`GhostArchiveArchiver: direct URL verified, archive exists at ${archiveUrl}`);
				return [{ url: archiveUrl, timestamp }];
			}

			// 404 means no archive exists
			if (response.status === 404) {
				console.log(`GhostArchiveArchiver: no archive found at ${archiveUrl} (404)`);
				return [];
			}

			// Other status codes (503, 403, etc.) might indicate blocking or temporary issues
			console.log(`GhostArchiveArchiver: unexpected status ${response.status}, archive may or may not exist`);
			return [];

		} catch (error) {
			console.error(`GhostArchiveArchiver: error checking direct URL: ${error}`);
			return [];
		}
	}

	async extractTitle(archivedUrl: string): Promise<string> {
		try {
			const response = await requestUrl({
				url: archivedUrl,
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
				}
			});
			
			if (response.status === 200) {
				const $ = cheerio.load(response.text);
				let title = $('title').text().trim();
				// Remove Ghostarchive suffix
				title = title.replace(/\s*\|\s*Ghostarchive\s*$/, '');
				return title || archivedUrl;
			}
			return archivedUrl;
		} catch (error) {
			console.error("Error extracting title from Ghostarchive:", error);
			return archivedUrl;
		}
	}
}
// Settings
class LinkArchiverSettingTab extends PluginSettingTab {
	plugin: LinkArchiverPlugin;

	constructor(app: App, plugin: LinkArchiverPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

display(): void {
  const { containerEl } = this;
  containerEl.empty();

  // Create tabs
  const tabsContainer = containerEl.createDiv({ cls: "settings-tabs" });

  const generalTab = tabsContainer.createDiv({ cls: "settings-tab general-tab" });
  generalTab.textContent = "General";

  const exclusionTab = tabsContainer.createDiv({ cls: "settings-tab exclusion-tab" });
  exclusionTab.textContent = "Exclusion Rules";

  // Content containers
  const generalContent = containerEl.createDiv({ cls: "settings-content general" });
  const exclusionContent = containerEl.createDiv({ cls: "settings-content exclusion" });

  // Tab switching logic
  generalTab.addEventListener("click", () => {
    generalTab.addClass("active");
    exclusionTab.removeClass("active");
    generalContent.addClass("active");
    exclusionContent.removeClass("active");
  });

  exclusionTab.addEventListener("click", () => {
    generalTab.removeClass("active");
    exclusionTab.addClass("active");
    generalContent.removeClass("active");
    exclusionContent.addClass("active");
  });

  // Set default visible tab
  generalTab.click();

  // General Settings
  generalContent.createEl("h3", { text: "Link Archiver Settings" });
  
  // Archive site selection
  new Setting(generalContent)
    .setName("Archive site")
    .setDesc("Choose which archive service to use. Note: archive.today variants have been removed due to CAPTCHA requirements. GhostArchive may also require CAPTCHA verification. Wayback Machine (web.archive.org) is recommended.")
    .addDropdown((dropdown) => {
      Object.keys(ARCHIVE_SITES).forEach(site => {
        dropdown.addOption(site, site);
      });
      dropdown.setValue(this.plugin.settings.archiveSite)
        .onChange(async (value) => {
          this.plugin.settings.archiveSite = value;
          await this.plugin.saveSettings();
        });
    });
  
  // Show ribbon icon
  new Setting(generalContent)
    .setName("Show Ribbon Icon")
    .setDesc("Toggle the ribbon icon on or off.")
    .addToggle(toggle =>
      toggle
        .setValue(this.plugin.settings.showRibbonIcon)
        .onChange(async (value) => {
          this.plugin.settings.showRibbonIcon = value;
          await this.plugin.saveSettings();
          this.plugin.updateRibbonIcon();
      })
  );

  // Format settings section
  generalContent.createEl("h5", { text: "Format Settings" });

    // Examples section
    generalContent.createEl("h6", { text: "Format Examples" });
    const exampleEl = generalContent.createEl("ul");
    
    // Show examples with the current divider text
    const divider = this.plugin.settings.dividerText || " | archive: ";
    
    if (this.plugin.settings.useNakedUrls) {
      exampleEl.createEl("li", {
        text: `Naked URLs: https://example.com${divider}https://archive.ph/abc123`
      });
      if (this.plugin.settings.preserveMarkdownLinks) {
        exampleEl.createEl("li", {
          text: `Preserved markdown: [User's Custom Title](https://example.com)${divider}https://archive.ph/abc123`
        });
      }
    } else if (this.plugin.settings.useNakedArchiveOnly) {
      exampleEl.createEl("li", {
        text: `Markdown with naked archive: [Example Page](https://example.com)${divider}https://archive.ph/abc123`
      });
    } else {
      exampleEl.createEl("li", {
        text: `Markdown links: [Example Page](https://example.com)${divider}[${this.plugin.settings.archiveText}](https://archive.ph/abc123)`
      });
    }

  new Setting(generalContent)
    .setName("Divider text")
    .setDesc("Text to place between the original link and the archive link.")
    .addText((text) =>
      text.setValue(this.plugin.settings.dividerText)
        .setPlaceholder(" | ")
        .onChange(async (value) => {
          this.plugin.settings.dividerText = value;
          await this.plugin.saveSettings();
        })
    );
  
  // Archive text setting
  new Setting(generalContent)
    .setName("Archive text")
    .setDesc("Text to display for the archive link. Default is '(archive)'.")
    .addText((text) =>
      text.setValue(this.plugin.settings.archiveText)
        .setPlaceholder("(archive)")
        .onChange(async (value) => {
          this.plugin.settings.archiveText = value;
          await this.plugin.saveSettings();
        })
    );
  
  // Always show "Preserve markdown links" option first
  const preserveDescription = this.plugin.settings.useNakedUrls
    ? "Keep existing Markdown links as is. Note: This has no effect when 'Use naked URLs' is enabled."
    : "Keep existing Markdown links as is. When disabled, titles will be scraped from the target website.";
    
  new Setting(generalContent)
    .setName("Preserve markdown links")
    .setDesc(preserveDescription)
    .addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.preserveMarkdownLinks).onChange(async (value) => {
        this.plugin.settings.preserveMarkdownLinks = value;
        await this.plugin.saveSettings();
        // Don't refresh the display to avoid hiding this option
      })
    );
  
  new Setting(generalContent)
    .setName("Use naked URLs")
    .setDesc("Format archive links as plain URLs instead of Markdown links.")
    .addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.useNakedUrls).onChange(async (value) => {
        this.plugin.settings.useNakedUrls = value;
        // If turning on naked URLs, disable naked archive only (they conflict)
        if (value && this.plugin.settings.useNakedArchiveOnly) {
          this.plugin.settings.useNakedArchiveOnly = false;
        }
        await this.plugin.saveSettings();
        // Refresh display to update dependent settings
        this.display();
      })
    );
    
  if (!this.plugin.settings.useNakedUrls) {
    new Setting(generalContent)
      .setName("Use naked archive links only")
      .setDesc("Keep original links as markdown but use plain URLs for archive links.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.useNakedArchiveOnly).onChange(async (value) => {
          this.plugin.settings.useNakedArchiveOnly = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );
  }

  new Setting(generalContent)
    .setName("Auto-pick latest archive")
    .setDesc("If multiple archives exist, automatically pick the latest available. Disable to select from a list.")
    .addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.autoPickLatestArchive).onChange(async (value) => {
        this.plugin.settings.autoPickLatestArchive = value;
        await this.plugin.saveSettings();
        // Refresh the display to show/hide the max snapshots setting
        this.display();
      })
    );

// Only show max snapshots setting if auto-pick is disabled
if (!this.plugin.settings.autoPickLatestArchive) {
  new Setting(generalContent)
    .setName("Maximum snapshots")
    .setDesc("Maximum number of snapshots to show when multiple are found.")
    .setClass("setting-indent")
    .addText(text => 
      text
        .setValue(this.plugin.settings.maxSnapshots.toString())
        .onChange(async (value) => {
          // Parse the input as a number
          const numValue = parseInt(value);
          
          // Validate the input is a number within range
          if (!isNaN(numValue) && numValue >= 1 && numValue <= 300) {
            this.plugin.settings.maxSnapshots = numValue;
            await this.plugin.saveSettings();
          } else {
            // If invalid, show a notice and don't save
            new Notice("Please enter a number between 1 and 300");
            // Reset to current value
            text.setValue(this.plugin.settings.maxSnapshots.toString());
          }
        })
    );
}
    // Confirmation settings
    generalContent.createEl("h5", { text: "Confirmation Settings" });
    
    new Setting(generalContent)
      .setName("Confirm note archiving")
      .setDesc("Show confirmation dialog before archiving all links in a note.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.confirmNoteArchiving).onChange(async (value) => {
          this.plugin.settings.confirmNoteArchiving = value;
          await this.plugin.saveSettings();
        })
      );
      
    // Reporting settings
    new Setting(generalContent)
      .setName("Detailed reporting")
      .setDesc("Show detailed information about skipped links during batch archiving.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.detailedReporting).onChange(async (value) => {
          this.plugin.settings.detailedReporting = value;
          await this.plugin.saveSettings();
        })
      );

    // Title scraping settings
    generalContent.createEl("h5", { text: "Title Scraping Settings" });

    new Setting(generalContent)
      .setName("Scrape page titles")
      .setDesc("Automatically fetch and use page titles when converting naked URLs to markdown links.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.scrapePageTitles).onChange(async (value) => {
          this.plugin.settings.scrapePageTitles = value;
          await this.plugin.saveSettings();
          this.display(); // Refresh to show/hide dependent settings
        })
      );

    if (this.plugin.settings.scrapePageTitles) {
      new Setting(generalContent)
        .setName("Enable title cache")
        .setDesc("Cache page titles for 24 hours to improve performance and reduce network requests.")
        .setClass("setting-indent")
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.enableTitleCache).onChange(async (value) => {
            this.plugin.settings.enableTitleCache = value;
            await this.plugin.saveSettings();
          })
        );

      new Setting(generalContent)
        .setName("Title fetch timeout")
        .setDesc("Maximum time (in seconds) to wait when fetching page titles. Default: 10 seconds.")
        .setClass("setting-indent")
        .addText((text) =>
          text
            .setValue((this.plugin.settings.titleFetchTimeout / 1000).toString())
            .onChange(async (value) => {
              const numValue = parseFloat(value);
              if (!isNaN(numValue) && numValue >= 1 && numValue <= 60) {
                this.plugin.settings.titleFetchTimeout = numValue * 1000; // Convert to milliseconds
                await this.plugin.saveSettings();
              } else {
                new Notice("Please enter a number between 1 and 60 seconds");
                text.setValue((this.plugin.settings.titleFetchTimeout / 1000).toString());
              }
            })
        );
    }

    // Exclusion Settings Tab Content
    exclusionContent.createEl("h3", { text: "Exclusion Rules" });
    
    // Standard exclusion settings
    exclusionContent.createEl("h5", { text: "Standard Exclusion" });
    
    new Setting(exclusionContent)
      .setName("Exclude folders")
      .setDesc("Comma-separated list of folders to exclude from batch archiving (e.g., 'Daily Notes, Templates').")
      .addText((text) =>
        text.setValue(this.plugin.settings.excludeFolders.join(", "))
          .onChange(async (value) => {
            // Split by comma and trim whitespace
            this.plugin.settings.excludeFolders = value.split(",")
              .map(folder => folder.trim())
              .filter(folder => folder.length > 0);
            await this.plugin.saveSettings();
          })
      );
      
    new Setting(exclusionContent)
      .setName("Exclude files with tags")
      .setDesc("Comma-separated list of tags. Files with these tags will be excluded (e.g., 'noarchive, private').")
      .addText((text) =>
        text.setValue(this.plugin.settings.excludeFilesWithTags.join(", "))
          .onChange(async (value) => {
            // Split by comma and trim whitespace, ensure tags start with #
            this.plugin.settings.excludeFilesWithTags = value.split(",")
              .map(tag => {
                tag = tag.trim();
                return tag.startsWith('#') ? tag : `#${tag}`;
              })
              .filter(tag => tag.length > 1); // Filter out empty tags
            await this.plugin.saveSettings();
          })
      );
      
    // Inverted exclusion settings
    exclusionContent.createEl("h5", { text: "Targeted Archiving" });
    exclusionContent.createEl("p", {
      text: "When enabled, only files matching these criteria will be processed during batch archiving.",
      cls: "setting-item-description"
    });
    
    new Setting(exclusionContent)
      .setName("Enable targeted archiving")
      .setDesc("Only process files matching the target criteria below.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.useInvertedExclusion).onChange(async (value) => {
          this.plugin.settings.useInvertedExclusion = value;
          await this.plugin.saveSettings();
        })
      );
      
    new Setting(exclusionContent)
      .setName("Target folders")
      .setDesc("Comma-separated list of folders to include in batch archiving (e.g., 'Research, Projects').")
      .addText((text) =>
        text.setValue(this.plugin.settings.targetFolders.join(", "))
          .onChange(async (value) => {
            // Split by comma and trim whitespace
            this.plugin.settings.targetFolders = value.split(",")
              .map(folder => folder.trim())
              .filter(folder => folder.length > 0);
            await this.plugin.saveSettings();
          })
      );
      
    new Setting(exclusionContent)
      .setName("Target files with tags")
      .setDesc("Comma-separated list of tags. Only files with these tags will be processed (e.g., 'archive, research').")
      .addText((text) =>
        text.setValue(this.plugin.settings.targetFilesWithTags.join(", "))
          .onChange(async (value) => {
            // Split by comma and trim whitespace, ensure tags start with #
            this.plugin.settings.targetFilesWithTags = value.split(",")
              .map(tag => {
                tag = tag.trim();
                return tag.startsWith('#') ? tag : `#${tag}`;
              })
              .filter(tag => tag.length > 1); // Filter out empty tags
            await this.plugin.saveSettings();
          })
      );
      
  }
}
