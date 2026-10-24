# AtmoScholar

A tracker for atmospheric science: new papers, jobs, funding calls, conferences and social media searches.

- **Papers** load live from [OpenAlex](https://openalex.org) in the browser.
- **Jobs**, **funding** and the **CO₂ reading** are collected once a day by the GitHub Action in `.github/workflows/deploy.yml`, which runs `scripts/fetch_jobs.py` and `scripts/fetch_extras.py` and then publishes the site to GitHub Pages.
- **Conferences** live in `data/events.json`, and hand-added jobs in `data/jobs-manual.json`. Edit either file on GitHub and the site updates within a few minutes.

To refresh everything right away, open the **Actions** tab, choose **Update data and publish site**, and click **Run workflow**.
