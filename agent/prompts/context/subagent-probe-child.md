Run this single bash command once, then return its final marker as your reply. This is a synthetic coordination test; do not edit any other files or spawn children.

```bash
printf ready > child-running.flag
for i in $(seq 1 240); do
  if [ -f parent-resumed.flag ]; then printf CHILD_BEFORE_OK; exit 0; fi
  sleep 0.25
done
exit 1
```
