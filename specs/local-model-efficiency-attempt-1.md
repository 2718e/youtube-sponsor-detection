## Background

Noticed that often there are crashes saying "Could not establish connection, receiving end does not exist."

When checking logs from my local model the calls are definitely happening. Some of them take a large amount of time to complete though (> 10 seconds)

Suspiction: either timeouts are happening or local model is going down due to being overloaded (e.g. too many parallel requests)

## Things to do for now

Focusing on relatively easy fixes to solve the problem

Check if calls to the model have a timeout, whether explicitly defined or implicit as the default in a library. If there is, can we increase it to 30 seconds
Limit the amount of parallel calls to the model. Queue them up and only have a maximum of MAX_PARALLEL_REQUESTS=4 running at once.