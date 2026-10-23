---
"dsh-mnemon-provider-retaindb": patch
---

RetainDB now receives importance on its own 0 to 1 scale. Memory Spaces gives every memory an importance from 1 to 5, and 3 when the writer gives none, and RetainDB was sent that number as is: RetainDB Server refuses any importance above 1, so it turned down writes at importance 2 to 5, the default included, and RetainDB Local stored every one of them at its highest importance. Importance 3 is now sent as 0.7, and each step above or below moves it by 0.1, so 1 to 5 are sent as 0.5 to 0.9, the band RetainDB's own writers use. An importance that is not a whole number is rounded, one outside 1 to 5 is clamped, and one that is not a number counts as none, as in Holographic. RetainDB Local still adds a bonus for the text and caps the result at 0.99, so the higher importances of a rich text can store the same value, and memories it stored at 0.99 before keep that value and can outrank new ones.
