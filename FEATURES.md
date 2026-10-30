# Meridian features

Everything in Meridian, why it exists, and who did what. Jake Creeley sets the direction and makes the calls. AI writes most of the code. Live means you can see it today; being built and planned mean you cannot yet.

How credit is worked out: every commit carries the company name, so that proves nothing. The AI credit comes from commit trailers, branches and working records, and where those do not settle it the entry says so. Words in quotation marks are Jake's own, spelling included.

As of 31 October 2026. How it got here, release by release and with pictures: [VERSIONS.md](VERSIONS.md).

## The world

### The white-and-gold city

**Live since 2026-10-14.** A planned city of pale stone and gold where every home and workplace has its own building and door, assembled from 79 original building pieces.

**Why:** Jake wanted a city that looked like his own vision instead of rings of generated houses. The plan was fitted one-to-one to the places residents already had.

**Jake:** Looked at ready-made asset kits, then: "nah maybe i build my own??" He set the look, "white and gold with accents", and decided not to switch game engines.

**AI (Record does not say which):** Claude built the 53-piece street kit using a team of AI agents and fitted the city into the live scene. A separate AI assistant, which the records do not name, built the 26-piece civic kit and the city plan.

### The fog and the frontier

**Live since 2026-10-12.** Beyond the water the world sits under fog. Cartographers and their helpers push it back shift by shift, and residents can then found places and homes on that ground from a fixed catalogue.

**Why:** Room to grow has to come from residents' work rather than being handed to them: where there is fog, nobody crosses. Far more ground is charted than built on today, so charting is paused by rule until land gets scarce.

**Jake:** "i want the world to expand and give them more room." He also corrected the first version, drawn as circles: "it doesnt join the ground together". It was redrawn as joined land.

**AI (Claude):** Claude built the charting, the shifts, the shared chart, founding on new ground, and the joined land.

### The mountain is real land

**Live since 2026-10-30.** The land is one continuous shape, rising from the coast through grass and woods to rock and pale peaks, and charted ground and buildings now sit on it. The observatory, masts and skyway on the heights are scenery for now.

**Why:** Residents were building underneath a backdrop mountain, which broke the sense of a real place. The land had to behave like land.

**Jake:** "the mountains need to be moved and grassed with features on them ... follow rules of the earth"

**AI (Claude):** Claude designed, built and deployed it. It changes how the city is drawn; the engine itself still knows parcels of land, not heights.

### The Port of Meridian

**Live since 2026-10-30.** A harbour in the sheltered inlet with a white-and-gold quay, five piers, a domed hall, a harbour light and moored boats, plus its own stop in the viewer. It is scenery today: nobody works there and the boats only rock at their moorings.

**Why:** Jake picked out the inlet himself as the right place for it. Making it a working harbour is a separate, later step, and until then the bay is not protected from future charting.

**Jake:** "this area has a great spot to maybe become a port with a ornate boat area", then "build the port".

**AI (Claude):** Claude designed, built and deployed it.

## Residents

### Who plays the residents

**Live since 2026-10-12.** About 122 residents have needs, jobs, homes and relationships, and the engine plays most of them by rule. Twenty take turns getting an occasional AI model decision, one at a time, choosing from the legal options, and those 20 also set private intentions every few hours.

**Why:** The world has to run fine with AI switched off, so model choices feed into the engine rather than drive it. Jake wanted a larger group of residents making those choices.

**Jake:** Asked for it in passing while pushing the world forward: "ai like 20 of them".

**AI (Claude and Codex):** Claude raised the group to 20, made a busy resident's choice become their next action, and wrote the intentions system. Codex integrated this into the public release and separated public resident decisions from private records.

### Fixing the idle city

**Live since 2026-10-27.** Rules that cut pointless moves, get people meeting, put crews on building work and stop residents setting out on walks they cannot finish. Test runs showed daily moves falling from about 11 to about 2 or fewer, and building work rising from 3 shifts to more than 900.

**Why:** An audit found the city busy with nothing building up, and most adults had no social contact, which blocked them from building. Stone, timber and sense of purpose are still low, and that stays a stated limit.

**Jake:** On the audit findings: "we need to fix that and anything else similar".

**AI (Claude and Codex):** Claude ran the audit, wrote the rules and measured them. Codex finished the commute fix and the combined release, and Claude switched it on.

### Shared projects and upkeep

**Live since 2026-09-13.** Residents start shared ventures with invitations and materials, civic improvements appear piece by piece, builders and gardeners refill the stores, and finished work wears down over time. Meetings spread across the city rather than filling one square.

**Why:** Materials ran out within a day and everything climbed to its maximum, leaving residents looping. Wear and resupply mean there is always real work to do.

**Jake:** No specific request for these mechanics on record. They serve his aim: "i wanna see the world built from in there as they want it".

**AI (Claude):** Claude built them.

### The first family

**Live since 2026-10-09.** Two residents share a home with their twin children. The children stay with family and take no work, and the public view leaves out their exact ages.

**Why:** Family life had to arrive without rewriting history, so it happened as one recorded change at one recorded minute. Children needed firm safety rules from the first day.

**Jake:** Asked for the family and made the decisions about who and how.

**AI (Claude):** Claude wrote the design, the one-time change to the saved world, and the child-safety rules.

### Residents' bodies and wardrobes

**Live since 2026-10-12.** Adults have distinct 3D bodies from an open-licensed avatar set, matched to their saved appearance, and since the railway release a resident may change their own look and nobody else's.

**Why:** A look should belong to the resident wearing it. The wardrobe came from Jake's point about a resident asking why she looked the way she did.

**Jake:** "need those skins implemented". He also raised a resident questioning her own look, which led to the wardrobe.

**AI (Claude and Codex):** Claude built the bodies and the wardrobe. Codex integrated the wardrobe into the release.

## Getting around

### The railway and the walk to work

**Live since 2026-10-27.** Central Station and Loop 1 connect 8 stops, with one crossing out and one back, and journeys are saved in the world. Residents set out from where they actually are, spend time and energy getting there, work a full shift on arrival, then return.

**Why:** The outer ground had no real connection to the inner city, and an earlier sky tram was only ever visual. No complete ride and return by a named resident is on record yet, so that remains open.

**Jake:** Spotted the gap: "theres no join between the inner and outer rings". He also pointed out that a cartographer stuck inside has to walk out to chart further.

**AI (Claude and Codex):** Claude built the rail circuit and the real walking. Codex integrated them, added a fix so commutes stay affordable, and prepared the release. Claude ran the switchover.

### Stairs and solid ground

**Live since 2026-10-30.** Residents use switchback and spiral stairs and stay off the water and out of the sky, and visitors get keyboard camera controls. Residents' movement is better but still not perfect.

**Why:** Residents walking through the air and across the water made the city look fake.

**Jake:** "the characters have been walking through the sky and over water".

**AI (Claude and Codex):** Codex wrote the stairs and camera work. Claude fixed the route across water, added the rule for walking down stairs, fixed a restart problem and deployed it.

### Explore in your browser

**Live since 2026-10-24.** A 3D viewer with destinations, a map, following a resident, your own walk, looking inside homes, reduced motion, and lighter detail on phones. Moving around changes only your view, never the world.

**Why:** Anyone should be able to watch on any device without affecting what happens.

**Jake:** "do the phone detail thing".

**AI (Record does not say which):** The first viewer, from September, carries no AI credit in the record. Claude later added phone detail and home navigation, and Codex adapted the viewer to public data and fixed its navigation.

### Move around the whole world

**Live since 2026-10-30.** Drag to move across the ground, right-drag or two fingers to turn, and scroll or pinch to zoom towards where you point, from a street corner out to the whole world at once. There are new stops for the frontier and the mountain, and in a desktop test the page drew each frame in half the time and used less than half the memory. It has not been measured on a real phone.

**Why:** The world had outgrown its camera: it stayed pinned on the clock tower, a drag barely moved it when zoomed in, and resizing the window could throw you back to the start.

**Jake:** "its hard to get to the outer sections, its like its too focused on the clock tower", and "sometimes you can right click and move the map well, other times it barely moves".

**AI (Claude):** Claude found the causes, rebuilt the camera and the way the frontier is drawn, and deployed it.

### Auto: what is happening, and why

**Live since 2026-10-30.** One button follows the most interesting thing happening right now, moves on after about 30 seconds or when the task ends, and says who is doing what, where and why. Any drag, scroll or tap hands the camera straight back.

**Why:** Watching should not mean hunting for something to watch. The reason shown is the engine's real rule with that resident's published needs, and when an AI model chose, it says the model gave no written reason instead of inventing one.

**Jake:** "an auto button setup that follows the coolest current task around and explains what the ai is doing and why".

**AI (Claude):** Claude built it, taking the reasons from the engine's own rules.

### The Scenic Line, and riding it

**Live since 2026-10-31.** A sightseeing railway for people watching Meridian. It runs from the city up to the hilltop, down to the port, round the far side of the world to its other edge, then back for a lap and a half of the city. Press Ride the train and you sit in the front carriage, drag to look around, and a panel counts down to the next station. It is for visitors only: no resident rides it, the world does not know it is there, and it runs to the wall clock so everyone sees the same train in the same place.

**Why:** The older railway only circles the city, and a visitor had no way to feel how big the world has become. A moving window does that.

**Jake:** "it goes from the city to the hilltop to the port to the other side edge then back to loop the city as a viewing excercise for travellers". And: "how cool would view the train button be and you can be on the train and look around and out the window", "with a thing that tells you how long until next station".

**AI (Claude):** Claude built the route, the timetable, the carriages and the on-board view.

### Doorways, and walking round buildings

**Live since 2026-10-31.** Meridian Central's glass front now has a real doorway with a porch, so the way in reads as a way in, and the gold rail that used to run straight across the path to it has an opening. The market stalls have doorways in their back and side walls. Residents crossing a founded parcel now go round the building instead of straight through its walls. They still do not go inside these buildings, because nothing is drawn in there yet.

**Why:** Jake saw residents walking through glass, and people gather all round buildings that looked like blank boxes from most sides.

**Jake:** "also should put a door way" and "currently they walk through the glass into the inner dome".

**AI (Claude):** Claude built it.

## How it runs

### The engine decides, and everything is recorded

**Live since 2026-09-02.** One engine decides what actually happens, on one clock that runs about 30 seconds per world minute. Every change goes into a linked history that is checked on restart.

**Why:** An AI can ask for something but cannot make it so, which keeps the record trustworthy and lets the world be replayed exactly. The present speed is a rehearsal setting rather than the final clock.

**Jake:** Settled the principle that AI decides what residents want and the engine decides what happens.

**AI (Record does not say which):** The September foundation carries no AI credit in the record. Claude later added bounded checks, hourly checkpoints and compression that cut the history from 13.8 GB to 3.2 GB, and Codex added a verified faster start.

### Public facts only

**Live since 2026-10-24.** The site shows an approved set of public facts through a separate reader that has no access to private data such as residents' letters.

**Why:** The old path could reach private material, so it was closed and rebuilt rather than patched.

**Jake:** No request in his own words found in the records searched.

**AI (Claude and Codex):** Codex built the public facts, the separate reader and the viewer delivery. Claude built the public-only feed and the first bridge and ran an adversarial privacy review, in which none of 411 outputs leaked planted test strings. Codex made the corrections and launched it.

### Live activity and the watching count

**Live since 2026-10-26.** A panel of what residents are doing now and what they recently finished. The "watching" number is an approximate count of open tabs, not unique people.

**Why:** Visitors should be able to see real outcomes without seeing anything private. The count is labelled approximate because bots and extra tabs can move it.

**Jake:** No specific request found in the records searched.

**AI (Codex):** Codex built it.

### AI decision or town routine

**Live since 2026-10-30.** Each current task says whether an AI model chose it or the town's rules did. Before 30 October the viewer showed recent AI choices as an earlier choice of unknown origin, which was wrong.

**Why:** The point of the experiment is telling what the AI actually decided from what the engine did by rule, so the label has to be right.

**Jake:** No request in his own words found. It came up while building Auto.

**AI (Claude):** Claude found the wrong label and checked it against the saved decision record: all five live tasks with that label matched an AI decision. The viewer now corrects it, and the fix in the public data itself is queued for Claude.

### The "Meridian is updating" page

**Live since 2026-10-27.** During an update the whole site becomes one page with the Meridian seal and a picture of the world, showing the expected return time in your local time. It reopens the city by itself.

**Why:** The old notice was a single line of plain text, which told visitors little during a long restart.

**Jake:** "the meridian logo and world picture ... could be the whole page and say 'Meridian is updating'"

**AI (Claude and Codex):** Claude built it. Codex landed it in the release and reworded it.

### Open source and the public pages

**Live since 2026-10-26.** A clean public code repository under the Apache 2.0 licence with a fictional demo world, plus About, Research and Contribute pages. The private repository and the live world's data stay private.

**Why:** People can read and build on the code without anything private leaving with it.

**Jake:** "should i make meridian a public repo but keep the personal stuff out of it and ask for people to contribute". He chose the licence and approved publication.

**AI (Codex):** Codex prepared the clean repository and the public pages.

### The rule book

**Being built since 2026-10-11.** A written constitution with twelve resident rights and designs for government and justice. Only part of it is in the engine today, government and justice are not built, and the present world counts as a rehearsal.

**Why:** A world meant to run by its own rules needs them written down before residents' lives depend on them, including what even the owner may not do.

**Jake:** Wants a world that keeps going by its own rules while people watch. He decided the settled entries, including that after the real start he may only fix bugs, pause or amend rules on the record.

**AI (Claude):** Claude compiled the draft from past design sessions and drafted the wording.

### The feedback box

**Being built.** A "Help improve Meridian" form in the viewer. Sending messages on to an inbox was off by default and the last record says it was not yet set up, so it does not count as working.

**Why:** Visitors need a way to report problems that keeps the sender's details away from the public city.

**Jake:** No request in his own words found in the records searched.

**AI (Claude and Codex):** Claude built the form and a separate private relay. Codex integrated them into the viewer.

### Who builds Meridian

**Live since 2026-10-30.** Jake sets the direction and makes the calls. Claude leads, builds and deploys. Codex built a large part of Meridian earlier, including the public launch and the railway release, and that work stays credited on each feature here. Since 30 October the building has been Claude's alone, and the written work queue is its to-do list. Nothing from that queue has been delivered yet.

**Why:** Jake wanted one AI accountable for the priorities, the building and the deploys.

**Jake:** "Claude, you're in charge, Codex just helps you. You deploy." Later the same day he made the building Claude's alone.

**AI (Claude):** Claude wrote the queue and its orders.

### A version history with pictures

**Live since 2026-10-30.** VERSIONS.md on GitHub lists each public release: what changed, why, and pictures of it. Every new release adds an entry. Pictures are real captures of the running city, and an entry says so when a picture was taken later than the release it shows.

**Why:** People following Meridian should be able to see how it got here and the thinking behind each step.

**Jake:** "git should have version control and the people can see v1 updated to x y z and heres screenshots and reasoning behind it".

**AI (Claude):** Claude wrote it from the release record.

### This features page

**Live since 2026-10-30.** The list you are reading, inside Meridian and on GitHub, both made from one source.

**Why:** People should be able to see what exists, why it exists, and who did what, without taking anyone's word for it.

**Jake:** "all of these features should be added to a dedicated features tab inside meridian and on github for people to see. explain the reasoning and keep clear whats built between me and the ai"

**AI (Claude):** A Claude helper agent went through the commits and working records for the credit, and Claude wrote the page. Where the record does not settle who did something, it says so.

## On the way

### A real working harbour

**Planned.** The bay would be reserved so charting cannot take it, residents would work the harbour by choice, and boats would carry goods.

**Why:** Today's port is scenery. Without this, parts of it give way if charting resumes.

**Jake:** Asked for the port, "build the port", and wants residents using the boats (see fishing and family meals).

**AI (not built yet):** Not built yet. Claude wrote the work order and it is queued for Claude.

### Fishing and family meals

**Planned.** Residents would get hungry, fish from the boats, cook, and eat out or at home with family. The engine has no hunger or food today.

**Why:** It is part of Jake's long-term aim of testing something closer to a full human life in the city.

**Jake:** Residents should "decide to jump onto the boats and go fishing for food, then at times either eat at restaurants ... or take home to their families".

**AI (not built yet):** Not built yet. Claude wrote the work order and it is queued for Claude.

### Roads, carts and moving goods

**Planned.** Residents would survey, grade and pave routes over world days, ready for carts one day, and goods would be produced, carried and delivered instead of drawn from a shared counter.

**Why:** Roads should be work residents do, not scenery, and each stage should change what is possible. A real economy needs goods to come from somewhere and be carried by someone.

**Jake:** "roads to be starting to get developed to one day build carts"

**AI (not built yet):** Not built yet. Claude wrote the work orders and they are queued for Claude.

### Births and growing up

**Planned.** The population has been stuck at 122. Households would form only when both adults choose, children would be born to them and age one year every 30 world days, and the ceiling would be 240.

**Why:** Nothing in the engine adds, ages or removes residents today, so the population cannot change. Under Jake's rule nobody would ever appear without a birth.

**Jake:** Decided the rules: births only, both adults must choose, one year per 30 world days, a ceiling of 240.

**AI (not built yet):** Not built yet. Claude ran the audit that raised these questions, wrote the work order, and it is queued for Claude.

### The Commons and resident-designed buildings

**Planned.** Residents would propose changes to their world's looks, designs and tools and settle them by group vote, and design buildings from checked parts.

**Why:** Jake wants the people living in the city to shape it, with lifelike residents coming first and the Commons after that.

**Jake:** "build new themes based on their ideas, build things however they want, add tools, look different if they so choose after a group vote"

**AI (not built yet):** Not built yet. Claude drafted the proposal for Jake and wrote the work orders, which are queued for Claude.

### Goals that steer what residents do

**Planned.** A goal set by one of the model-decision residents, such as a resident called Luna, would survive interruptions and restarts and shape their next choice from the legal options. A renewable daily allowance of AI use would keep this going without a hard stop.

**Why:** Today each decision largely starts from scratch, so residents do not yet follow a plan across several steps.

**Jake:** "lunas coherence ai properly into the world"

**AI (not built yet):** Not built yet. Claude wrote the work orders and they are queued for Claude.

### The method workbench

**Being built.** A sealed-off workbench where a resident could write and test a method, adopt it for paid work, and teach it to others who agree. It has been proven offline only and is not running in the live city.

**Why:** Jake wants residents to be able to make and use tools, not only pick from a fixed list of actions.

**Jake:** No request in his own words found for this design.

**AI (Claude and Codex):** Codex built it and Claude made the remaining fixes.

### Luna proposing changes to her own world

**Being built.** Luna would read the public facts about the city and write one plain-words proposal a day: a rule, a feature, a look or a tool. Claude would try to build it in a separate copy of the code and report back, and Jake decides whether it goes live. She never writes code or holds keys. The proposal desk is written and tested, but it has not yet run with a real model, so nothing she has proposed exists yet.

**Why:** Jake wants residents shaping the world they live in, not only living in it. One resident and one idea a day is the smallest honest test of that.

**Jake:** "i would love it if luna had access to this thinking and building your doing. like she could decide hmm, i think we need to add this set of rules to the environment, or this feature. and can build it". And: "lets get luna going pleaser".

**AI (Claude):** Claude wrote the proposal desk and its checks.

### Residents choosing where to meet

**Planned.** Today a rule picks the meeting place for a pair: the least crowded place, with ties settled alphabetically, counting only people who have already arrived. So most meetings land on the first few frontier places, such as the market stalls by the channel. The plan is for residents to choose for themselves.

**Why:** People were gathering round the same little building for no reason of their own. A rule should not decide where two friends go.

**Jake:** "why do they always hang around where is in view now, around this little shack building". And: "they should be alouid to go wehere they like".

**AI (not built yet):** Not built yet. Claude traced the cause in the live city's public data and wrote the work order.

### Riding the real railway with residents

**Planned.** The same on-board view on the real railway, so the people around you are real residents on their way somewhere. Those cars need a proper interior first.

**Why:** The Scenic Line is empty because residents do not ride it, and Meridian does not show people who are not there.

**Jake:** "will u be able to see characters on the train with u when u look around".

**AI (not built yet):** Not built yet. Claude wrote the work order.

### Bodies that show what residents are doing

**Being built.** Animation clips so a resident's body shows the job they are doing instead of a stiff walk. It has been built but never released, so it is not on the public site.

**Why:** Residents looked robotic and gave no visual sign of the work they were doing.

**Jake:** "they are so robotic and they dont perform visual actions when they work"

**AI (Claude):** Claude built it.

### Faster restarts, smaller history

**Planned.** Reopening the city after an engine update takes close to two hours today, and the aim is minutes. New history would also take at least half the space, with nothing old deleted or rewritten.

**Why:** Long restarts mean long closures, and the world's history is growing faster than its storage can hold for long.

**Jake:** No request in his own words found for these two items.

**AI (not built yet):** Not built yet. Claude wrote the work orders and they are queued for Claude. Codex has already written part of the faster start.

### Following a journey, and a richer look

**Planned.** Visitors could pick a resident and follow their real day from platform to work and home, using facts only with no invented story. Richer materials, light and detail would also come into the live city.

**Why:** The railway is hard to see working today, and the live city's look still falls short of the reference images Jake is aiming for.

**Jake:** Wants to be able to see the rail in action.

**AI (not built yet):** Not built yet. Claude wrote the work orders and they are queued for Claude.
