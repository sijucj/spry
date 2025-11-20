```bash task-1 --descr "A demo task"
echo "task-1 successful"
```

```bash task-2 --dep task-3 --descr "Another demo task"
echo "task-2 successful"
```

```bash task-3 --descr "Another demo task"
#!/usr/bin/env -S bash
echo "task-3 successful"
```
