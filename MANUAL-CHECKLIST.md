# Manual verification checklist

Automated tests (`npm test`, `npm run e2e`) cannot cover a real browser profile, a real API key, or a real job posting. Walk through this once before relying on the extension.

1. **Load the extension.** Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the `dist/` folder. The extension appears with no errors.
2. **Add your API key.** Open the extension's **Settings** page, paste a real OpenAI API key, and save. Reload the page and confirm the key is still there.
3. **Check the Profile tab.** The Form view renders personal details, links, job preferences, work authorization, diversity, truth rules and role angles. Experience, education and skills are not shown there; they live in the JSON tab.
4. **Check the Preview tab.** Pick a role. Confirm it shows **only the selected role** and nothing from the other two. This is your only way to see exactly what reaches the model.
5. **Fill a real posting.** Open one real job posting, open the popup, pick a role under "Fill as", and press **Fill this form**.
6. **Verify the count.** The popup reports "Scanned N · filled M · skipped K". Compare against the page: the filled fields match M, and the fields left blank match K. Confirm the form was **not submitted**.
7. **Try the tooltip.** Click into one essay question and click the ✨ icon.
   1. Generate an answer, then press **Regenerate** and check you get a new one.
   2. Press **Shorter** and check the answer is shorter.
   3. Type an extra instruction and regenerate; check it is reflected.
   4. Confirm the page's textarea is **still empty or unchanged** through all of the above.
   5. Press **Insert** and confirm the text is written only now.
8. **Log the application.** In the popup, press **Log this application**, review the captured fields, and save. Open the **Dashboard** and confirm the new row is there.
9. **Check spend.** On the Dashboard, confirm the spend figure is non-zero after the real calls above, and that there is **no "unpriced" warning** for the models you configured.

## If something looks wrong

- **Page-side errors** (scanning, filling, the tooltip): open DevTools on the job page and read the Console.
- **Background errors** (API calls, usage, storage): go to `chrome://extensions`, find JobFill AI, and click **service worker** to open its own console. These do not appear in the page console.
- **Fill reports "No frame responded":** reload the page and try again. The content script had not loaded yet.
- **Stale or odd answers:** Settings, then **Clear answer cache**, resets all cached AI answers.
- After rebuilding (`npm run build`), click the reload icon on the extension card.
