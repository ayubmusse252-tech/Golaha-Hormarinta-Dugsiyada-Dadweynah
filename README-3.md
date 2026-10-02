# Imtixaan-Sameeye

App samaynaya imtixaanaada dugsiga, oo ku dhisan Bloom's Taxonomy, ku salaysan buugga/qoraalka aad geliso (ku dheji gacanta, ama soo geli PDF/DOCX — xitaa PDF sawir ah (scanned) waa la akhrin karaa adoo isticmaalaya OCR).

## Sida loo deploy-garaysto (GitHub + Railway — isla habka appkii hore)

1. **GitHub**: samee repo cusub, ku shubo (push) dhammaan faylasha folder-kan.
2. **Railway**: `New Project` → `Deploy from GitHub repo` → dooro repo-gan.
3. Ku dar **Postgres plugin** (`New` → `Database` → `Add PostgreSQL`) — Railway ayaa si otomaatig ah u dejin doona `DATABASE_URL`.
4. Ku dar labadan **Variables** ee adeegga (service) ee Node-ka:
   - `ADMIN_PASSWORD` — sirta aad ku geli doonto app-ka.
   - `ANTHROPIC_API_KEY` — furahaaga Claude API (ka hel https://console.anthropic.com/settings/keys).
5. Railway ayaa si otomaatig ah u dejin doona `PORT`. Deploy-ku wuu bilaabmi doonaa — ka eeg "Deploy Logs" si aad u hubiso inuu leeyahay "🚀 Server wuxuu ku shaqeynayaa" iyo "✅ Database ready".
6. Fur URL-ka Railway kuu siiyay, geli password-ka — waad diyaar u tahay.

## Qaababka ku jira

- Ku dar dhowr "Cashar/Cutub", mid kastaba magaciisa (Cutubka X) iyo bogagga (24-31).
- Soo geli PDF/DOCX/TXT, ama ku dheji qoraalka gacanta.
- PDF sawir ah (scanned) — taabo **"🔍 Akhri Sawirka (OCR)"**, Claude ayaa sawirrada ka akhrin doona qoraalka.
- Diagram/sawir otomaatig ah oo loogu daro su'aalaha u baahan (xisaab, saynis, iwm).
- Imtixaanada la sameeyay waa la keydiyaa (Postgres) — waxaad mar dambe ka furi kartaa "📚 Imtixaanadii Hore".
- 🖨️ Daabac / Save PDF si aad u daabacdo ama u kaydiso.

## Local development

```
npm install
ADMIN_PASSWORD=test ANTHROPIC_API_KEY=sk-ant-... DATABASE_URL=postgres://... npm start
```
