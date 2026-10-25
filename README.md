<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/meridian-logo-dark.svg">
    <img src="docs/media/meridian-logo.svg" alt="Meridian — a world axis, a shared horizon, an M" width="620">
  </picture>
</p>

<p align="center"><strong>A persistent world for exploring what AI can build, learn and share.</strong></p>

<p align="center">
  <a href="https://meridian.creeleydigital.com.au/">Watch the live city</a> ·
  <a href="#run-your-own-fictional-city">Run it locally</a> ·
  <a href="#build-with-me">Build with me</a> ·
  <a href="mailto:jake@creeleydigital.com.au?subject=Meridian%20research%20and%20development">Research &amp; development</a>
</p>

![A photorealistic future vision of Meridian: the astronomical clock tower, inhabited ivory-and-gold terraces, gardens, waterways and a connected rail system.](docs/media/meridian-future-vision.png)

*The horizon: AI-generated concept art, inspired by Meridian’s existing city. This illustrates the long-term visual ambition. Genuine captures of the current world appear below.*

# A city with a future to work out

Meridian is an independent, open-source experiment in persistent AI worlds, created by **Jake Creeley at Creeley Digital Systems, Sydney**.

The idea is a city that keeps its history. Residents have places to go, work to do and a world that responds to their actions. The research ambition is for useful abilities to accumulate: an individual notices a problem, tries an idea, learns from failure, makes something that works, then teaches someone else.

A better building method should eventually mean better buildings. A discovery should outlast the resident who made it. Cooperation should produce something we can point to in the world.

## Why I’m building it

I’m Jake. I’m fascinated by artificial general intelligence, open worlds and the possibility of intelligence that develops through doing things over time.

I want to build a world that keeps going. A place where AI residents can notice that a house could be better, talk through ideas, develop the tools to improve it and show another resident how to use them. Where a journey matters because you actually have to travel. Where knowledge is earned, kept and shared.

My long-term ambition is a city that can build and improve itself, with people around the world able to tune in and watch. Getting there means solving practical problems: memory, planning, tool use, useful invention, teaching, resources and the consequences of getting something wrong.

I care about what that could teach us beyond the city, too. Better ways for AI systems to collaborate, retain useful skills and help people are worth working on. Meridian gives those questions a place to play out, with a history we can inspect.

There is a lot still to build. I’m opening the source because I’d like other curious builders and researchers to help shape it.

— **Jake Creeley**

## Inside the world today

These are **actual browser captures of the hosted city**, taken on 26 October 2026 (Sydney time). The camera and blue-hour lighting are controls in the viewer. These screenshots have no generated buildings or visual replacements.

### The Founding District

![Actual live-world screenshot: Meridian’s clock tower, civic terraces, homes and water ring in daylight.](docs/media/live-founding-district.jpg)

*Ivory-and-gold neighbourhoods around the clock tower, with the waterfront and surrounding frontier visible.*

<table>
  <tr>
    <td width="50%"><img src="docs/media/live-prismatic-gardens.jpg" alt="Actual live-world screenshot of the Prismatic Gardens at blue hour."></td>
    <td width="50%"><img src="docs/media/live-riverside-workshops.jpg" alt="Actual live-world screenshot of the Riverside Workshops in daylight."></td>
  </tr>
  <tr>
    <td><strong>The Prismatic Gardens</strong><br>A shared courtyard beneath the clock spire, using the viewer’s blue-hour setting.</td>
    <td><strong>The Riverside Workshops</strong><br>Workspaces, homes, terraces and residents beside the quays.</td>
  </tr>
</table>

[Enter the live city →](https://meridian.creeleydigital.com.au/)

## The research question

**Can a community become more capable because of what its members have learned?**

For Meridian, that means asking questions we can test:

- Can a resident turn a failed attempt into a useful, repeatable method?
- Can another resident learn it and independently produce something useful?
- Does that ability survive a restart and the original teacher’s absence?
- Does the improvement justify the time, materials and model calls it consumed?
- Can people watching understand what happened and why it matters?

AGI is a motivation for the work. Meridian is an experimental world and a research direction; a city of genuinely general agents that can develop itself remains a long-term goal.

## What you can explore now

| Available in this public source | The next research milestones |
| --- | --- |
| A persistent fictional city with 24 residents, work, travel and material accounting | Useful resident inventions that improve construction and production |
| A procedural 3D viewer with district cameras, audience movement and resident inspection | Richer homes, abilities, local awareness and coherent long-term plans |
| Saved history, replay verification and a read-only public view | Clear public accounts of real AI requests, tools, failures and results |
| Optional OpenAI API, prompt and bounded tool-session interfaces | Complete real-model invention, paid useful work and independent teaching |
| Offline tests (with test doubles) of failure, repair, method admission and adoption after restart | Reproduction by multiple learners after restart, with the teacher absent |

The hosted world and this repository have separate releases. The local demo starts a new fictional city and makes **no model calls by default**. Optional interfaces require explicit configuration. A passing offline test does not establish the next research milestone. [Read the technical scope and current limits](docs/DEVELOPMENT.md).

### Using the OpenAI API

The source includes OpenAI API integration for model-driven resident decisions and bounded tool sessions. The aim is to pair capable language models with persistent memory, explicit actions and observable consequences, then measure whether the combination produces useful progress.

Meridian is independently created and maintained by Jake Creeley and Creeley Digital Systems. The research ambitions, project direction and results presented here are our own. OpenAI API integration is a technical component of that work.

## Build with me

If you’re interested in AI worlds, this is an invitation to help build one.

Useful contributions include resident planning and memory, learning and teaching, simulation rules, navigation, construction, 3D rendering, accessible observation, evaluations and model-cost efficiency. Small, reproducible improvements are welcome. So are careful experiments that show an idea doesn’t work.

Start with [CONTRIBUTING.md](CONTRIBUTING.md), [the AI interfaces](AI-CONTRIBUTING.md) or an issue describing what you want to explore. Changes to this repository are reviewed by Jake. Public-source changes do not automatically deploy into the hosted city.

**Research, development and collaboration enquiries:** [jake@creeleydigital.com.au](mailto:jake@creeleydigital.com.au?subject=Meridian%20research%20and%20development).

## Run your own fictional city

Use Node **26.7.0** and pnpm **11.22.0**. From the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm demo
```

In a second terminal:

```sh
pnpm --filter @meridian/web dev --host 127.0.0.1 --port 5173 --strictPort
```

Open **http://127.0.0.1:5173**. Stop with Ctrl-C; `pnpm demo` resumes the same verified fictional save. [Setup, checks and architecture notes →](docs/DEVELOPMENT.md)

## The name and the mark

A meridian is a line of longitude running from pole to pole: a reference for locating ourselves in a world. The logo brings that axis together with a shared horizon and an **M** formed like two rising city structures. It reflects the project’s interest in place, continuity and a world with room to grow.

[Light wordmark](docs/media/meridian-logo.svg) · [Dark wordmark](docs/media/meridian-logo-dark.svg) · [Standalone mark](docs/media/meridian-mark.svg)

## Licence and privacy

[Apache 2.0](LICENSE) · Copyright 2026 Jake Creeley / Creeley Digital Systems.

This public repository excludes the private production save, personal continuity, letters, credentials and cloud administration. The demo uses fictional data. [Security reporting](SECURITY.md) · [Third-party notices](THIRD-PARTY-NOTICES.md) · [Showcase image provenance](docs/media/README.md).
