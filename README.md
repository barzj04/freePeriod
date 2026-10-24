# FreePeriod

Find the free periods in your week, and actually use them.

**Try it:** https://barzj04.github.io/freeperiod/ (works on phone and laptop, no sign up)

## Why we made this
I have hours between classes almost every day, and most of the time I end up doing nothing. I scroll, I procrastinate, and then it's time to go. This is called **waiting mode**, and it's really common for people with ADHD. When you have something later, the time before it doesn't feel usable.

FreePeriod is an AI study buddy for students who get stuck like this. It finds your free periods, fills them with small steps that fit, and tells you when to go.

## What it does
The app has 4 tabs:
- **Week:** a calendar of your classes and exams, plus a **weekly study plan** that fills your free time with study blocks (tap one to start it)
- **Plan:** tasks, brain dump, your plan and focus mode
- **Flashcards:** turn notes into quiz cards, with every deck saved so you can practise again
- **Progress:** how much you got done this week, how fast you work, and a check-in if you're overdoing it (tap **Show example data** to see it straight away)

1. **Reads your timetable (AI vision):** snap a photo or upload the PDF of your timetable or syllabus. AI pulls out your classes and exam dates and shows every free period in the next 7 days. Tap one to plan it. No photo? Tap **Type it in yourself**, or **Use a sample**.
2. **Weekly study plan:** tap **Plan my week** and AI spreads study blocks across your free periods. Nearest exams come first, the same subject is spread over different days, weekends are lighter, and there's a daily cap so you don't burn out. Each block says exactly what to do ("Practice questions: regression"). You can plan the next 4 weeks too. If you miss a block, tap **Re-plan the rest of the week** and it gets moved into your free time later. Tap any study block to change it, delete it or start it, or tap free time to add your own block.
3. **Brain dump:** tap the mic and say everything on your mind (English or Bahasa Melayu). AI turns it into a task list.
4. **Plans around your exams:** AI breaks your tasks into small steps (2 to 15 min) that fit your free period, and puts work for your nearest exam first.
5. **Learns your pace:** it compares how long you said a step would take with how long you actually took, and sizes future steps for *you*.
6. **Focus mode:** one step at a time on a time disc that shrinks as time goes by. Too hard? Tap **split smaller** and AI breaks it down more.
7. **Notes to flashcards:** paste your notes or upload a photo of them. AI makes quiz cards, and the ones you miss come back first.
8. **Burnout check:** if you keep skipping steps, study late at night, or have done 3+ hours today, it suggests a lighter plan or a real break.
9. **Leave alarm:** a heads up a few minutes before, then a full screen alarm when it's time to go. Unfinished steps carry over to your next free period.

## How we used AI
| Feature | AI used |
|---|---|
| Reading timetables and syllabuses (photo or PDF) | Claude Haiku 5.5 (vision + PDF input) via the Anthropic API |
| Brain dump to task list | Browser speech recognition (Web Speech API) + Claude |
| Weekly study plan and re-planning missed blocks | Claude (built-in planner as a fallback) |
| Step plans, exam-first ordering, "split smaller" | Claude |
| Notes to flashcards (text, photo or PDF) | Claude |
| Pace learning | Our own simple model: median of actual vs estimated time over your last 20 steps |
| Burnout check | Rule-based patterns from your history (skips, splits, late nights, hours today) |

If AI isn't available, FreePeriod still works: a built-in planner makes steps from templates, and flashcards become fill-in-the-blank cards made from your notes.

## How to run it
No setup needed. Keep all the files together and open `index.html` in Chrome, Edge or Firefox.

To install it as an app or use it offline, it needs a web address:
- **GitHub Pages:** push the folder, then Settings → Pages → deploy from the main branch.
- **On your laptop:** run `python -m http.server` in the folder and open http://localhost:8000.

### Turning on AI
Pick one:
- **Shared AI server (for judges and friends):** deploy the tiny Cloudflare Worker in [`worker/`](worker/README.md), then paste its URL into `PROXY_URL` at the top of `app.js`. Your key stays on Cloudflare, with daily limits.
- **Your own key:** Settings → choose Anthropic (Claude) or Google Gemini → paste your API key. It's only saved in your browser.

## Files
| File | What's in it |
|---|---|
| `index.html` | The page: screens, dialogs, settings |
| `styles.css` | Colours, fonts, light and dark mode, layout |
| `app.js` | All the logic: AI calls, timetable reading, free periods, planner, pace, burnout check, flashcards, timers, alarm |
| `worker/worker.js` | Shared AI server (Cloudflare Worker) that hides the API key |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and installing as an app |
| `fonts/` | Bricolage Grotesque and Atkinson Hyperlegible (SIL Open Font License) |

## Made for everyone
- Voice input if typing is hard, and a time disc for time blindness
- Atkinson Hyperlegible font, bigger text option, dark mode
- One step on screen at a time, and low energy mode for smaller steps
- Keyboard shortcuts: D done, S split, K skip, P pause, R read aloud
- Screen reader support and reduced motion

## What doesn't work yet
- AI can misread messy timetables, so check them with **Edit** (you can add, change or remove classes and exams there).
- Free periods are the gaps before each class (from 8am). Evenings after your last class aren't counted yet.
- The tab has to stay open for the alarm.
- Voice input works best in Chrome and Edge.

## Future improvements
- Google Calendar sync
- Spaced repetition for flashcards across days
- A weekly view of how much free time you turned into progress
- Smarter burnout check using AI on your notes and mood

## Team
- **Arleen:** idea and coding
- **Lester:** UI/UX design, demo video and the rest

## AI assistance and what we used
We used Claude (Anthropic) to help plan the project and to generate and optimize the code. We came up with the idea, made the design decisions, tested it and edited it. The app uses the Anthropic API (Claude Haiku 5.5), optionally Google Gemini, and the browser's Web Speech API. Fonts are from Fontsource (SIL Open Font License). No other libraries.
