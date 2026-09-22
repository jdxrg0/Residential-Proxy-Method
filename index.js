const puppeteer = require('puppeteer');

const targetUrl = process.env.CHAT_URL;
const targetMessage = process.env.CHAT_MESSAGE;
const codeMessage = process.env.CHAT_CODE_MESSAGE;
const e2eePin = process.env.FB_E2EE_PIN;
const reminderTasksRaw = process.env.REMINDER_TASKS || '[]';
let reminderTasks = [];

try {
  reminderTasks = JSON.parse(reminderTasksRaw);
} catch (e) {
  console.error("Failed to parse REMINDER_TASKS", e);
}

const delay = ms => new Promise(res => setTimeout(res, ms));

async function runAutomation() {
    console.log("🚀 Starting Messenger Automation...");

    const puppeteerArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ];

    if (process.env.PROXY_SERVER) {
      puppeteerArgs.push(`--proxy-server=${process.env.PROXY_SERVER}`);
    }

    const browser = await puppeteer.launch({
      headless: true, // Set to false if testing locally
      args: puppeteerArgs
    });

    let page;
    try {
        page = await browser.newPage();

        // 1. Authenticate the Proxy
        if (process.env.PROXY_USERNAME && process.env.PROXY_PASSWORD) {
          await page.authenticate({
            username: process.env.PROXY_USERNAME,
            password: process.env.PROXY_PASSWORD,
          });
        }

        // 2. Load and sanitize Facebook Cookies
        let cookies = [];
        try {
            cookies = JSON.parse(process.env.FACEBOOK_COOKIES || "[]");
        } catch (e) {
            console.log("No valid cookies found or parse error.");
        }
        
        cookies = cookies.map(cookie => {
            delete cookie.sameSite;
            return cookie;
        });
        if (cookies.length > 0) {
            await page.setCookie(...cookies);
        }

        // 3. Verify session & Auto-Login
        console.log("Navigating to facebook.com to verify session...");
        await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2', timeout: 60000 });
        
        let needLogin = false;
        
        // If we see the login URL, an email input, OR a "Continue" button from the Recent Logins screen, we need to log in.
        const isRecentLogins = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('div[role="button"], button, a[role="button"]'));
            return elements.some(el => el.innerText && el.innerText.trim() === 'Continue');
        });

        if (page.url().includes('login') || await page.$('input[name="email"]') || isRecentLogins) {
            needLogin = true;
            console.log("❌ Cookies are invalid or missing. Attempting auto-login...");
        } else {
            console.log("✅ Session is valid.");
        }

        if (needLogin) {
            const fbEmail = process.env.FB_EMAIL;
            const fbPassword = process.env.FB_PASSWORD;

            if (!fbEmail || !fbPassword) {
                console.error("❌ FB_EMAIL or FB_PASSWORD not provided. Cannot auto-login.");
            } else {
                console.log("Cookies are expired. Creating a fresh incognito context to force a clean login screen...");
                const context = await browser.createIncognitoBrowserContext();
                page = await context.newPage();

                // Authenticate proxy again for the new page
                if (process.env.PROXY_USERNAME && process.env.PROXY_PASSWORD) {
                    await page.authenticate({
                        username: process.env.PROXY_USERNAME,
                        password: process.env.PROXY_PASSWORD,
                    });
                }
                
                console.log("Navigating to standard login page...");
                await page.goto('https://www.facebook.com/login', { waitUntil: 'networkidle2', timeout: 60000 });
                
                console.log("Entering credentials...");
                await page.waitForSelector('input[name="email"]', { timeout: 30000 });
                await page.type('input[name="email"]', fbEmail, { delay: 50 });
                await page.type('input[name="pass"]', fbPassword, { delay: 50 });
                await page.keyboard.press('Enter');
                
                console.log("Waiting for login to complete...");
                try {
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
                } catch (e) {
                    console.log("Navigation timed out or didn't occur. Checking if password is required...");
                    const passInput = await page.$('input[name="pass"]');
                    if (passInput) {
                        console.log("Password required! Entering password...");
                        await page.type('input[name="pass"]', fbPassword, { delay: 50 });
                        await page.keyboard.press('Enter');
                        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
                    }
                }
                
                // Check if login succeeded
                if (page.url().includes('login') || await page.$('input[name="email"]')) {
                    console.error("❌ Login failed (incorrect password, or required manual verification).");
                    await page.screenshot({ path: 'debug.png', fullPage: true });
                } else {
                    console.log("✅ Auto-login successful!");
                    
                    // Capture new cookies
                    const newCookies = await page.cookies();
                    
                    // Update GitHub Secret
                    await updateGitHubSecret(newCookies);
                }
            }
        }

        // ----------------------------------------------------
        // PHASE 1: DISPATCH MAIN GROUP MESSAGE (IF APPLICABLE)
        // ----------------------------------------------------
        if (targetUrl && targetUrl.trim() !== '' && ((targetMessage && targetMessage.trim() !== '' && targetMessage.trim() !== 'NO_MESSAGE') || (codeMessage && codeMessage.trim() !== '' && codeMessage.trim() !== 'NO_MESSAGE'))) {
            console.log(`Navigating to group chat: ${targetUrl}`);
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            await delay(3000); // Stabilization

            console.log("Waiting for the chat box to load...");
            try {
                await page.waitForSelector('div[role="textbox"]', { timeout: 45000 });
                await delay(2000); // Give it a moment in case the E2EE popup triggers slightly after
            } catch (e) {
                console.log("⚠️ Timed out waiting for chat box. It might still be loading or hidden.");
            }

            // Handle E2EE Popup if it appears (now that the page is loaded)
            await handleE2EEPopup(page, e2eePin);

            console.log("Focusing the chat box...");
            const textBoxes = await page.$$('div[role="textbox"]');
            if (textBoxes.length > 0) {
                const chatBox = textBoxes[textBoxes.length - 1]; // Usually the last one
                await chatBox.focus();
                
                if (targetMessage && targetMessage.trim() !== '' && targetMessage.trim() !== 'NO_MESSAGE') {
                    console.log("Typing group message...");
                    const lines = targetMessage.split('\n');
                    for (let j = 0; j < lines.length; j++) {
                        await page.keyboard.type(lines[j], { delay: 10 });
                        if (j < lines.length - 1) {
                            await page.keyboard.down('Shift');
                            await page.keyboard.press('Enter');
                            await page.keyboard.up('Shift');
                        }
                    }
                    
                    await delay(1500);
                    console.log("Sending group message...");
                    await page.keyboard.press('Enter');
                    await delay(3000); // Wait for network dispatch
                }
                
                // If there's a separate confirmation code message, send it now
                if (codeMessage && codeMessage.trim() !== '' && codeMessage.trim() !== 'NO_MESSAGE') {
                    console.log("Typing separate code message...");
                    const codeLines = codeMessage.split('\n');
                    for (let j = 0; j < codeLines.length; j++) {
                        await page.keyboard.type(codeLines[j], { delay: 10 });
                        if (j < codeLines.length - 1) {
                            await page.keyboard.down('Shift');
                            await page.keyboard.press('Enter');
                            await page.keyboard.up('Shift');
                        }
                    }
                    await delay(1500);
                    console.log("Sending separate code message...");
                    await page.keyboard.press('Enter');
                    await delay(3000);
                }

                console.log("✅ Successfully sent message(s) to group!");
            } else {
                console.log("❌ Could not find group chat text box.");
            }
        } else {
            console.log("⏭️ Skipping Main Group Message (Both dynamic message and code message were empty).");
        }

        // ----------------------------------------------------
        // PHASE 2: DISPATCH INDIVIDUAL ROLE REMINDERS
        // ----------------------------------------------------
        if (reminderTasks.length > 0) {
            console.log(`\n📬 Processing ${reminderTasks.length} Individual Role Reminders...`);

            for (let i = 0; i < reminderTasks.length; i++) {
                const task = reminderTasks[i];
                console.log(`\nNavigating to private chat: ${task.url}`);
                await page.goto(task.url, { waitUntil: 'networkidle2', timeout: 60000 });
                await delay(3000);

                console.log("Waiting for private chat box to load...");
                try {
                    await page.waitForSelector('div[role="textbox"]', { timeout: 45000 });
                    await delay(2000); // Give it a moment for E2EE popup
                } catch (e) {
                    console.log("⚠️ Timed out waiting for private chat box.");
                }

                await handleE2EEPopup(page, e2eePin);

                // --- CHECK CHAT HISTORY FOR CONFIRMATION CODE ---
                console.log("Scanning recent chat history for confirmation code...");
                const chatHistoryText = await page.evaluate(() => {
                    return document.body.innerText; 
                });

                if (chatHistoryText.includes(task.expectedCode)) {
                    console.log(`✅ Member ALREADY CONFIRMED using code ${task.expectedCode}. Skipping reminder.`);
                    continue; // Skip to next task
                }

                // If not confirmed, send the reminder
                console.log(`❌ No confirmation code found. Sending nudge to member...`);

                const textBoxes = await page.$$('div[role="textbox"]');
                if (textBoxes.length > 0) {
                    const chatBox = textBoxes[textBoxes.length - 1];
                    await chatBox.click();
                    await delay(1000);
                    
                    const pLines = task.message.split('\n');
                    for (let j = 0; j < pLines.length; j++) {
                        await page.keyboard.type(pLines[j], { delay: 10 });
                        if (j < pLines.length - 1) {
                            await page.keyboard.down('Shift');
                            await page.keyboard.press('Enter');
                            await page.keyboard.up('Shift');
                        }
                    }
                    
                    await delay(2000); // Give React time to recognize the text and enable the Send button
                    
                    await page.keyboard.press('Enter');
                    await delay(15000); // 15s Network dispatch for slow proxies
                    console.log("✅ Sent private reminder successfully.");
                } else {
                    console.log("❌ Could not find private chat text box.");
                }
            }
        }

        await page.screenshot({ path: 'debug.png', fullPage: true });
        console.log("📸 Saved debug screenshot.");

    } catch (error) {
        console.error("Execution Error:", error);
        if (typeof page !== 'undefined') {
            try {
                await page.screenshot({ path: 'debug.png', fullPage: true });
                console.log("📸 Saved debug screenshot on error.");
            } catch (e) {
                console.error("Failed to take error screenshot:", e.message);
            }
        }
    } finally {
        await browser.close();
    }
}

async function handleE2EEPopup(page, pin) {
    try {
        console.log("Checking for E2EE PIN Pop-up...");
        await page.waitForSelector('div[role="dialog"]', { timeout: 3000 }).catch(() => null);
        
        const dialogs = await page.$$('div[role="dialog"]');
        let targetDialog = null;
        
        for (const d of dialogs) {
            const text = await page.evaluate(el => el.innerText || "", d);
            if (text.includes("PIN") || text.includes("restore your chats") || text.includes("Enter your") || text.includes("one-time code")) {
                targetDialog = d;
                break;
            }
        }
        
        if (targetDialog) {
            console.log("🔒 E2EE PIN Pop-up detected.");
            if (pin) {
                console.log("Entering PIN...");
                const inputs = await targetDialog.$$('input');
                if (inputs.length > 0) {
                    await inputs[0].focus();
                    
                    // Clear existing value just in case
                    await page.evaluate(el => el.value = '', inputs[0]);
                    
                    await page.keyboard.type(pin, { delay: 100 });
                    await delay(1000);
                    
                    console.log("Waiting for chat history to decrypt and load...");
                    
                    try {
                        await page.waitForFunction(() => {
                            const ds = Array.from(document.querySelectorAll('div[role="dialog"]'));
                            return !ds.some(d => (d.innerText || "").includes("PIN"));
                        }, { timeout: 25000 });
                        console.log("E2EE popup disappeared successfully.");
                    } catch (e) {
                        console.log("E2EE popup is still verifying or stuck. Trying to press Escape to dismiss it.");
                        await page.keyboard.press('Escape');
                        await delay(2000);
                    }
                    
                    await delay(2000); // Give the UI a moment to settle
                    return;
                }
            }
            
            console.log("No PIN provided or no inputs found. Attempting to close the popup...");
            const closeBtn = await targetDialog.$('div[aria-label="Close"], div[aria-label="Close"] i');
            if (closeBtn) {
                await closeBtn.click();
                console.log("Closed E2EE popup via button.");
            } else {
                await page.keyboard.press('Escape');
                console.log("Sent Escape key to close E2EE popup.");
            }
            await delay(1500);
        } else {
            if (dialogs.length > 0) {
                console.log("🔓 Dialogs found, but none look like an E2EE prompt.");
            } else {
                console.log("🔓 No E2EE PIN Pop-up detected.");
            }
        }
    } catch (err) {
        console.log("Error handling E2EE popup, continuing...", err.message);
    }
}

runAutomation();

async function updateGitHubSecret(newCookies) {
    const _sodium = require('libsodium-wrappers');
    const pat = process.env.GITHUB_PAT;
    const repoFullName = process.env.GITHUB_REPOSITORY;
    const secretName = 'FACEBOOK_COOKIES';
    const secretValue = JSON.stringify(newCookies);

    if (!pat || !repoFullName) {
        console.error("❌ Missing GITHUB_PAT or GITHUB_REPOSITORY. Cannot update secret.");
        return;
    }

    const [owner, repo] = repoFullName.split('/');

    console.log("🔒 Encrypting new cookies and updating GitHub Secret...");

    try {
        // 1. Get the repository public key
        const pkRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`, {
            headers: {
                'Authorization': `token ${pat}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        
        if (!pkRes.ok) {
            throw new Error(`Failed to fetch public key: ${await pkRes.text()}`);
        }
        
        const pkData = await pkRes.json();
        const keyId = pkData.key_id;
        const key = pkData.key;

        // 2. Encrypt the secret
        await _sodium.ready;
        const binkey = _sodium.from_base64(key, _sodium.base64_variants.ORIGINAL);
        const binsec = _sodium.from_string(secretValue);
        const encBytes = _sodium.crypto_box_seal(binsec, binkey);
        const encryptedValue = _sodium.to_base64(encBytes, _sodium.base64_variants.ORIGINAL);

        // 3. Upload the encrypted secret
        const putRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/${secretName}`, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${pat}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                encrypted_value: encryptedValue,
                key_id: keyId
            })
        });

        if (putRes.ok) {
            console.log("✅ Successfully updated FACEBOOK_COOKIES secret in GitHub!");
        } else {
            throw new Error(`Failed to update secret: ${await putRes.text()}`);
        }
    } catch (err) {
        console.error("❌ Error updating GitHub secret:", err.message);
    }
}
