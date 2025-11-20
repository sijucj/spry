```bash task-1 --descr "A demo task"
echo "task-1 successful"
```

Run the task and capture it's output in `task2Output`, can retrieve it using
`${captured.task2Output}` in any `--interpolate` (or `-I`) cells:

```bash task-2 -C task2Output --dep task-3 --descr "Another demo task"
echo "task-2 successful"
```

Run the task and capture it's output in file `./task-3.txt`:

```bash task-3 --capture ./task-3.txt --gitignore --descr "Another demo task"
#!/usr/bin/env -S bash
echo "task-3 successful"
```

The `-I` allows _unsafe_ interpolation so that we can use the output of
`task-2`:

```bash task-4 -I --descr "Show captured output"
#!/usr/bin/env -S cat
# from task-2 captured output: "${captured.task2Output.text().trim()}"
```
