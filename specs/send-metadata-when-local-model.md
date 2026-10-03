## Context

the local backend I'm using can accept an additional metadata parameter relative to the default systemone

this can be used to save requests for the purpose of tuning or investigating how it makes decisions on a particular task

(if a config flag is on in the model server, it will save requests that have metadata and a clientId in the metadata)

## What to do

Set things up so that when a `SEND_METADATA` flag is on and the model is local, we will send an additional metadata field in the requests with

{
    "clientId": "yt-sponsor-skip",
    "uri": <url of the video>,

}