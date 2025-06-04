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
  archiveSite: "archive.ph",
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
};

const ARCHIVE_SITES = {
	"archive.ph": "https://archive.ph",
	"archive.li": "https://archive.li",
	"archive.is": "https://archive.is",
	"archive.vn": "https://archive.vn",
  "archive.md": "https://archive.md",
  "archive.today": "https://archive.today",
  "ghostarchive.org": "https://ghostarchive.org",
  "web.archive.org": "https://web.archive.org/web"
};

export default class LinkArchiverPlugin extends Plugin {
	settings: LinkArchiverSettings;
  ribbonIconEl: HTMLElement | null = null;

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async onload() {
		await this.loadSettings();
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
					}
				}
			})
		);
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
		try {
			// Minimal headers to avoid detection
			const headers = {
				'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				'Accept-Language': 'en-US,en;q=0.5'
			};

			const response = await requestUrl({
				url: url,
				headers: headers
			});
			
			if (response.status === 200) {
				const $ = cheerio.load(response.text);
				
				// Simply get the title tag content
				const title = $('title').text().trim();
				
				if (title && title !== "") {
					return title;
				}
			}
			
			// If we couldn't get a title, extract domain
			const urlObj = new URL(url);
			return urlObj.hostname.replace(/^www\./, '');
		} catch (error) {
			if (this.settings.debugMode) {
				console.error("Error extracting title:", error);
			}
			
			// Implement retry logic with exponential backoff
			if (retryCount < 2) { // Try up to 3 times total (initial + 2 retries)
				const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s delay
				
				// Wait for the delay period
				await new Promise(resolve => setTimeout(resolve, delay));
				
				// Retry with incremented counter
				return this.extractTitleFromUrl(url, retryCount + 1);
			}
			
			// If all retries failed or we're not retrying, fall back to domain name
			try {
				const urlObj = new URL(url);
				return urlObj.hostname.replace(/^www\./, '');
			} catch {
				return "Link";
			}
		}
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
  snapshots?: { url: string, timestamp: string }[];
  rateLimited?: boolean;
}> {
  console.log(`Checking for existing archives of: ${originalUrl}`);
  
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
    // Wayback Machine API
    try {
      const checkUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(originalUrl)}&callback`;
      console.log(`Checking Wayback Machine API: ${checkUrl}`);
      
      const res = await requestUrl({
        url: checkUrl,
        headers: headers
      });
      if (res.status === 200 && res.json?.archived_snapshots?.closest?.available) {
        const snapshot = res.json.archived_snapshots.closest;
        console.log(`Found Wayback Machine snapshot: ${snapshot.url}`);
        
        return {
          foundArchive: true,
          archivedUrl: snapshot.url,
          snapshots: [{ url: snapshot.url, timestamp: snapshot.timestamp || 'Unknown' }]
        };
      } else if (this.settings.debugMode) {
        console.log(`No Wayback Machine snapshots found`);
      }
    } catch (err) {
      console.error("Error checking Wayback Machine:", err);
      
      // Check for rate limiting
      if (err.status === 429 ||
          (err.message && (
            err.message.includes("rate limit") ||
            err.message.includes("too many requests")
          ))) {
        console.log("Rate limited by Wayback Machine");
        return { foundArchive: false, rateLimited: true };
      }
      
      // Implement retry logic with exponential backoff
      if (retryCount < 2) { // Try up to 3 times total (initial + 2 retries)
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
        return {
          foundArchive: true,
          archivedUrl: snapshots[0].url,
          snapshots: snapshots
        };
      } else if (this.settings.debugMode) {
        console.log(`No Ghostarchive snapshots found for URL: ${originalUrl}`);
      }
    } catch (err) {
      console.error("Error checking Ghostarchive:", err);
      
      if (err.status === 429 ||
          (err.message && err.message.includes("rate limit"))) {
        console.log("Rate limited by Ghostarchive");
        return { foundArchive: false, rateLimited: true };
      }
    }
  } else {
    // Archive.today family sites - use HTML scraping
    console.log("Processing with archive.today family");
    try {
      if (this.settings.debugMode) {
        console.log(`Checking archive site for: ${originalUrl}`);
      }
      const snapshots = await this.getArchiveTodaySnapshots(originalUrl, archiveBaseUrl);

      if (this.settings.debugMode) {
        console.log(`getArchiveTodaySnapshots returned ${snapshots.length} snapshots`);
      }
      
      if (snapshots.length > 0) {
        if (this.settings.debugMode) {
          console.log(`Found ${snapshots.length} snapshots for archive.today`);
        }
        return {
          foundArchive: true,
          archivedUrl: snapshots[0].url, // Latest snapshot (already sorted)
          snapshots: snapshots
        };
      } else if (this.settings.debugMode) {
        console.log(`No archive.today snapshots found for URL: ${originalUrl}`);
      }
    } catch (err) {
      console.error("Error checking archive via HTML scrape:", err);
      
      // Check for rate limiting
      if (err.status === 429 ||
          (err.message && (
            err.message.includes("rate limit") ||
            err.message.includes("too many requests")
          ))) {
        console.log("Rate limited by archive.today");
        return { foundArchive: false, rateLimited: true };
      }
    }
  }
  
  console.log(`No archives found for: ${originalUrl}`);
  return { foundArchive: false };
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

	async getArchiveTodaySnapshots(originalUrl: string, archiveBaseUrl: string, retryCount = 0): Promise<{ url: string, timestamp: string }[]> {
		try {
			// Minimal headers to avoid detection
			const headers = {
				'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				'Accept-Language': 'en-US,en;q=0.5'
			};

			// For ghostarchive.org, use a single properly formatted search URL
			let searchUrl;
			if (this.settings.archiveSite === 'ghostarchive.org') {
			  searchUrl = `https://ghostarchive.org/search?term=${encodeURIComponent(originalUrl)}`;
			} else {
			  // For archive.today, try multiple search approaches
			  searchUrl = [
					`${archiveBaseUrl}/${originalUrl}`,
					`${archiveBaseUrl}/search/?q=${encodeURIComponent(originalUrl)}`,
					`${archiveBaseUrl}/${encodeURIComponent(originalUrl)}`
				];
			}
			
			for (const url of searchUrl) {
				try {
					const res = await requestUrl({
						url: url,
						headers: headers
					});
					
					if (res.status === 200) {
						const $ = cheerio.load(res.text);
						const snapshots: { url: string, timestamp: string }[] = [];
						
						// Look for snapshot links - they typically follow patterns like /abc123
						$('a[href]').each((_, el) => {
							const href = $(el).attr('href');
							const linkText = $(el).text().trim();
							
							// Match snapshot-style URLs
							if (href && /^\/[a-zA-Z0-9]{4,10}$/.test(href)) {
								let timestamp = '';
								
								// Method 1: Look for timestamp div with specific styling (archive.today format)
								const parentContainer = $(el).closest('tr, td, div, li');
								const timestampDiv = parentContainer.find('div[style*="color:black"][style*="font-size:9px"]');
								
								if (timestampDiv.length > 0) {
									timestamp = timestampDiv.text().trim();
								} else {
									// Method 2: Look for any div with timestamp-like content in the same container
									parentContainer.find('div').each((_, div) => {
										const divText = $(div).text().trim();
										if (this.isValidTimestamp(divText)) {
											timestamp = divText;
											return false; // Break out of each loop
										}
									});
									
									// Method 3: Look in adjacent cells or elements
									if (!timestamp) {
										const adjacentElements = parentContainer.siblings();
										adjacentElements.each((_, sibling) => {
											const siblingText = $(sibling).text().trim();
											if (this.isValidTimestamp(siblingText)) {
												timestamp = siblingText;
												return false; // Break out of each loop
											}
										});
									}
									
									// Method 4: Look for timestamp in the same table row
									if (!timestamp) {
										const tableRow = $(el).closest('tr');
										if (tableRow.length > 0) {
											tableRow.find('td, th').each((_, cell) => {
												const cellText = $(cell).text().trim();
												if (this.isValidTimestamp(cellText)) {
													timestamp = cellText;
													return false; // Break out of each loop
												}
											});
										}
									}
								}
								
								const fullUrl = `${archiveBaseUrl}${href}`;
                								
								// Only add if it's a valid archive URL and has a timestamp (if required)
								if (this.isValidArchiveUrl(fullUrl) && this.isValidArchiveSnapshot(fullUrl, originalUrl)) {
                  if (!this.settings.requireTimestamps || (timestamp && this.isValidTimestamp(timestamp))) {
                    snapshots.push({
                      url: fullUrl,
                      timestamp: timestamp || 'Unknown date'
                    });
                  }
                }
							}
						});
            						
						// Also look for full archive URLs but with stricter filtering
						$('a[href*="archive"]').each((_, el) => {
							const href = $(el).attr('href');
							if (href && href.startsWith('http') && this.isValidArchiveUrl(href)) {
								// Additional check: make sure this URL actually contains archive content
								// by checking if it contains the archive domain and a snapshot identifier
								const hasSnapshotIdentifier = /\/[a-zA-Z0-9]{4,}/.test(href) || /\/web\/\d+/.test(href);
								
								if (hasSnapshotIdentifier) {
									const linkText = $(el).text().trim();
									const parentRow = $(el).closest('tr, li, div');
									let timestamp = parentRow.find('.timestamp, .time, .date').first().text().trim() || '';
									
									// Try to extract timestamp from surrounding context
									if (!timestamp) {
										const parentText = parentRow.text();
										const timestampMatch = parentText.match(/\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}/);
										if (timestampMatch) {
											timestamp = timestampMatch[0];
										}
									}
									
									if (!this.settings.requireTimestamps || this.isValidTimestamp(timestamp)) {
										snapshots.push({
											url: href,
											timestamp: timestamp || 'Unknown date'
										});
									}
								}
							}
						});
            						
						// Remove duplicates and sort by timestamp if possible
						const uniqueSnapshots = snapshots.filter((snapshot, index, self) => 
							index === self.findIndex(s => s.url === snapshot.url)
						);
						
						if (this.settings.debugMode) {
							console.log(`Found ${uniqueSnapshots.length} valid snapshots for ${originalUrl}:`, uniqueSnapshots);
						}
						
              // After collecting all snapshots:
              if (uniqueSnapshots.length > 0) {
                // Score snapshots by relevance
                const scoredSnapshots = uniqueSnapshots.map(snapshot => ({
                  snapshot,
                  score: this.scoreSnapshotRelevance(snapshot, originalUrl)
                }));
                
                // Sort by score (highest first), then by timestamp if scores are equal
                scoredSnapshots.sort((a, b) => {
                  if (b.score !== a.score) {
                    return b.score - a.score;
                  }
                  
                  // If scores are equal, sort by timestamp
                  if (this.isValidTimestamp(a.snapshot.timestamp) && this.isValidTimestamp(b.snapshot.timestamp)) {
                    return new Date(b.snapshot.timestamp).getTime() - new Date(a.snapshot.timestamp).getTime();
                  }
                  return 0;
                });
                
                // Take only the highest scoring snapshots up to the max limit
                return scoredSnapshots.slice(0, this.settings.maxSnapshots).map(item => item.snapshot);
              }
					}

				} catch (urlErr) {
					console.log(`Failed to fetch ${searchUrl}:`, urlErr);
					continue;
				}
			}
		} catch (err) {
			console.error("Error fetching archive.today snapshots:", err);
			
			// Implement retry logic with exponential backoff
			if (retryCount < 2) { // Try up to 3 times total (initial + 2 retries)
				const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s delay
				console.log(`Retrying archive.today snapshot fetch in ${delay}ms...`);
				
				// Wait for the delay period
				await new Promise(resolve => setTimeout(resolve, delay));
				
				// Retry with incremented counter
				return this.getArchiveTodaySnapshots(originalUrl, archiveBaseUrl, retryCount + 1);
			}
		}
		return [];
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
	async showSnapshotModal(snapshots: { url: string, timestamp?: string }[]): Promise<string | null> {
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
				const archiveBaseUrl = ARCHIVE_SITES[this.plugin.settings.archiveSite as keyof typeof ARCHIVE_SITES];
				let archiveCreateUrl: string;
				
				if (this.plugin.settings.archiveSite === "web.archive.org") {
					archiveCreateUrl = `https://web.archive.org/save/${this.originalUrl}`;
				} else {
					// Archive.today family sites
					archiveCreateUrl = `${archiveBaseUrl}/?run=1&url=${encodeURIComponent(this.originalUrl)}`;
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

		const inputEl = contentEl.createEl("input", { type: "text", placeholder: "https://archive.ph/abc123 or https://web.archive.org/web/..." });
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
	snapshots: { url: string; timestamp?: string }[];
	originalUrl: string;
	onSubmit: (chosenUrl: string | null) => void;
	selectedUrl: string | null = null;

	constructor(app: App, plugin: LinkArchiverPlugin, snapshots: { url: string; timestamp?: string }[], originalUrl: string, onSubmit: (chosenUrl: string | null) => void) {
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
			linkEl.textContent = snapshot.timestamp ? `${snapshot.timestamp} — ${snapshot.url}` : snapshot.url;

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

	async getSnapshots(originalUrl: string): Promise<{ url: string, timestamp: string }[]> {
		// For YouTube links, keep full URL with protocol for searches
		let searchTerm = originalUrl;
		if (originalUrl.includes('youtube.com') || originalUrl.includes('youtu.be')) {
			// Keep full URL for YouTube searches
			searchTerm = originalUrl;
			console.log(`GhostArchiveArchiver: using full YouTube URL for search`);
		} else {
			// For non-YouTube URLs, remove protocol and trailing slashes
			searchTerm = originalUrl.replace(/^https?:\/\//, '');
			if (searchTerm.endsWith('/')) {
				searchTerm = searchTerm.slice(0, -1);
			}
		}
		
		const searchUrl = `https://ghostarchive.org/search?term=${encodeURIComponent(searchTerm)}`;
		console.log(`GhostArchiveArchiver: constructed search URL: ${searchUrl}`);

		// Extract video ID from YouTube URLs for archive reconstruction
		let videoId: string | null = null;
		if (originalUrl.includes('youtube.com') || originalUrl.includes('youtu.be')) {
			const youtubeMatch = originalUrl.match(/youtube\.com\/watch\?v=([^&]+)/) ||
								originalUrl.match(/youtu\.be\/([^?]+)/);
			if (youtubeMatch && youtubeMatch[1]) {
				videoId = youtubeMatch[1];
				console.log(`GhostArchiveArchiver: extracted YouTube video ID: ${videoId}`);
			}
		}
		
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
			const snapshots: { url: string, timestamp: string }[] = [];
			
			// Find all archive links with case-insensitive matching
			const links = $('a[href*="/archive/"], a[href*="/varchive/"]');
			console.log(`GhostArchiveArchiver: found ${links.length} archive links`);
			
			// Log all links if none found
			if (links.length === 0) {
				console.log("GhostArchiveArchiver: No archive links found. Full HTML structure:");
				console.log($.html());
			} else {
				links.each((i, el) => {
					const href = $(el).attr('href') || '';
					console.log(`GhostArchiveArchiver: Link ${i+1}: ${href}`);
				});
			}
			
			
			links.each((_, link) => {
				const $link = $(link);
				let href = $link.attr('href') || '';
				console.log(`GhostArchiveArchiver: processing archive link: ${href}`);
				
				// Skip if href is empty
				if (!href) {
					console.log(`GhostArchiveArchiver: skipping link with empty href`);
					return;
				}
				
				// Extract timestamp from the next table cell
				const $timestampTd = $link.closest('td').next('td');
				if (!$timestampTd.length) {
					console.log(`GhostArchiveArchiver: cannot find timestamp cell`);
					return;
				}
				
				let timestamp = $timestampTd.text().trim();
				// Clean up any extra whitespace or HTML entities
				timestamp = timestamp.replace(/\s+/g, ' ').replace(/&nbsp;/g, ' ');
				console.log(`GhostArchiveArchiver: extracted timestamp: ${timestamp}`);
				
				// Skip validation for now - just require non-empty
				if (!timestamp) {
					console.log(`GhostArchiveArchiver: empty timestamp`);
					return;
				}
				
				// For YouTube links, look for video ID in href
				if (videoId) {
					// Check if href contains the video ID
					if (href.includes(videoId)) {
						const baseUrl = href.includes('/varchive/')
							? 'https://ghostarchive.org/varchive/'
							: 'https://ghostarchive.org/archive/';
						href = `${baseUrl}${videoId}`;
					} else {
						// If video ID not found, try matching the last part of href
						const hrefId = href.split('/').pop();
						if (hrefId && hrefId === videoId) {
							const baseUrl = href.includes('/varchive/')
								? 'https://ghostarchive.org/varchive/'
								: 'https://ghostarchive.org/archive/';
							href = `${baseUrl}${videoId}`;
						}
					}
				}
				// For non-YouTube links
				else {
					const baseUrl = href.toLowerCase().includes('/varchive/')
						? 'https://ghostarchive.org/varchive/'
						: 'https://ghostarchive.org/archive/';
					href = `${baseUrl}${href.split('/').pop()}`;
				}
				
				const url = href;
				
				console.log(`GhostArchiveArchiver: found valid snapshot at ${url} with timestamp ${timestamp}`);
				snapshots.push({ url, timestamp });
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
    .setDesc("Choose which archive service to use.")
    .addDropdown((dropdown) => {
      Object.keys(ARCHIVE_SITES).forEach(site => {
        dropdown.addOption(site, site);
      });
      // Add ghostarchive.org explicitly since it's now in ARCHIVE_SITES
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
