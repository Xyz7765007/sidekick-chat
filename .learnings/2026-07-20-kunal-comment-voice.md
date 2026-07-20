# 2026-07-20 — Comment voice modelled from Kunal's real comments

Source: 7 posts + Kunal's 7 actual comments (Samarth, 2026-07-20). Encoded in
`lib/comment-voice.js`, imported by comment-angles, generate-comment and
post-chat. Present in BOTH sidekick-posts and sidekick-chat.

## What the data said (measured, not guessed)
7/7 comments start lowercase · 23-58 words, MEDIAN 31 · 1-2 short paragraphs ·
0 hashtags, 0 emojis, 0 em dashes, 0 praise openers · 2/7 contain a question ·
3/7 hedge ("i think", "read somewhere", "guessing") · 3/7 draw on his own
experience.

## His four moves (he NEVER summarises the post back)
1. TRANSPOSE the post's mechanic into his world (outbound/GTM, sales data,
   agency delivery, running his company) and name the same gap there. Most
   common and most valuable move.
2. PRINCIPLE or PREDICTION — a remembered heuristic or forward call, hedged
   and concrete ("10% innovative 90% familiar"; "$10 to $100 a month niche SaaS").
3. FIRST-HAND with a real timeframe AND what is still unsolved ("took us a
   year… still involved. but significantly lesser").
4. LEADING QUESTION carrying a thesis, backed by what he has observed.
He is ADDITIVE, never contrarian: he pushes back by adding a frame, not by
telling the author they are wrong. He states scale humility when the post's
stakes exceed his own ("though never with stakes this high").

## Guardrails learned during QA
- **Never fabricate his facts.** First pass invented "our show rate was around
  55%" and "a record month" — he would have posted a false claim about his own
  business under his own name. Rule added: no invented metrics/clients/dates;
  stay qualitative ("took us a while") when no fact was supplied.
- **Internal taxonomy must not leak** into chip labels/hints (angles were
  printing "Transpose: …" to the operator).
- **Length anchors to the ceiling.** Stating "20-60 words" produced 52-63-word
  drafts. Stating his MEDIAN (31) with a 25-40 target and 60 as a rarely-used
  ceiling pulled it to a 46 median, 11/12 inside his observed range.

## Verification
0 style violations and 0 fabricated self-metrics across 10 generated comments;
re-measured across 12 more after the length fix. Compared side by side against
his real comments on the same two posts (hotel complexity, SaaS shutdowns).

## Note
The voice file is the BASELINE. Learned prefs from the feedback loop layer on
top and OVERRIDE it — as Kunal edits drafts and posts his own versions, those
exemplars pull length and phrasing further toward him automatically.
