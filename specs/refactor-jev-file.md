## Background

The src/jev.ts file is hard to read due to being very long.

## What to do

Want to split this into 2 files in a subfolder

subfolder named decisionModel with files

prompts.ts
runner.ts

prompts.ts will contain those parts of jev.ts that are mainly concerned with setting up and defining the prompts and questions
runner.ts witll contain the remainder of jev.ts (that is, the parts about orchestrating the scan, cut, and refine strategy)