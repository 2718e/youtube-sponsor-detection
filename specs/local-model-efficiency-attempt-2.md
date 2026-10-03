## Background

Here's some logs from the local model server

[2026-10-03T01:02:15.577Z] POST /v1/systemone -> 200 in 7061.8ms
  model=english
  state: {"video_title": "Why the EU Wants to Expand the Single Market", "before": "(start of the video)", "phrases": "P01| Next week, once\nP02| European Commission President\nP03| Ursula Vonlayan gets\nP04| back from\nP05| the Balkans, one\nP06| of her top\nP07| advisers is due\nP08| to propose a\nP09| slew of reforms\nP10| to EU", "after": "member states that would aim to finally break its accession log jam and herald in an autumn of enlargement. According to a report published by Politico on Wednesda…(+177 chars)
  questions: {"P01": {"type": "noul", "instructions": {"question": "Does phrase P01 in `phrases` belong to the sponsor segment rather than to the video's own content? The phrases are consecutive pieces of the transcript, a few words each; `before` and `after` are the surrounding transcript, and the sponsor is named at `sponsor_named_at_text`.", "definition": "A sponsor segment is the part of a video that exists to promote a third party that paid for placement: a product, service, app or company. It is usuall…(+16670 chars)
  routing: english (English Latin text)
  usage: input_tokens=3880 output_tokens=0
  answers: P01=0.42 P02=0.41 P03=0.40 P04=0.40 P05=0.40 P06=0.41 P07=0.40 P08=0.39 P09=0.39 P10=0.39
INFO:     127.0.0.1:52810 - "POST /v1/systemone HTTP/1.1" 200 OK
[2026-10-03T01:02:31.419Z] POST /v1/systemone -> 200 in 22899.4ms
  model=english
  state: {"video_title": "Why the EU Wants to Expand the Single Market", "before": "Wednesday, one proposed measure will involve expanding the EU single market to advanced candidate countries, provided they agree to stand with the EU against hostile states and industrial rivals. So, in this video, we're going", "phrases": "P01| to take another\nP02| look at the\nP03| EU single market,\nP04| this new plan\nP05| to expand it, and\nP06| whether it's a\nP07| good idea. If\nP08| you're interested in\nP09| the…(+558 chars)
  questions: {"P01": {"type": "noul", "instructions": {"question": "Does phrase P01 in `phrases` belong to the sponsor segment rather than to the video's own content? The phrases are consecutive pieces of the transcript, a few words each; `before` and `after` are the surrounding transcript, and the sponsor is named at `sponsor_named_at_text`.", "definition": "A sponsor segment is the part of a video that exists to promote a third party that paid for placement: a product, service, app or company. It is usuall…(+28689 chars)
  routing: english (English Latin text)
  usage: input_tokens=8296 output_tokens=0
  answers: P01=0.41 P02=0.40 P03=0.41 P04=0.41 P05=0.41 P06=0.40 P07=0.40 P08=0.41 P09=0.40 P10=0.40 P11=0.41 P12=0.40 P13=0.41 P14=0.40 P15=0.40 P16=0.41 P17=0.42
INFO:     127.0.0.1:52810 - "POST /v1/systemone HTTP/1.1" 200 OK

## Preliminary analysis

It looks to me that asking multiple questions in one go - potentially while repeating definitions for each question - leads to long prompts which have quite a lot of performance content. Wondering about reducing the size of the prompt?

## Specific ideas to explore

1 - Would there be anything in the interface for either jev or laya that would avoid the need to repeat the definitions in `SPONSOR` for each question multiple times?

2 - Could this be split into multiple calls rather than sending all the questions at once? (configurable spilt)

3 - Do we need to ask the question for every phrase? Since what we really want is to find the transition point between sponsored and not sponsored content - could we do a binary search (or another strategy that would allow us to take advantage of asking some number of questions between 1 and all of them at a time)

4- It also looks like we're potentially reaching the cut stage when we've only reached the MAYBE threshold (or what it was before I increased it) - why is that? What's the point if we haven't reached the threshold to actually skip?

## What agent should do?

Have a think, research the codebase (and if needed, docs for laya / jev ) to come up with answers to the questions.

For questions 1, 2, 3, if these can be done give a plan to build them (which I will then approve or discuss further).