```c
void swap(int *p, int *q) {
    int tmp = *p;
    *p = *q;
    *q = tmp;
}
```

Summarise a column of numbers from the shell.

```sh
cut -d, -f2 grades.csv | sort -n | uniq -c | sort -rn | head
```

Count the lines of every data file.

```sh
for f in data/*.csv; do
    echo "$f has $(wc -l < "$f") lines"
done
```

Group quiz scores in a database query.

```sql
SELECT student, AVG(score) AS mean_score
FROM quiz
GROUP BY student
HAVING COUNT(*) >= 3
ORDER BY mean_score DESC;
```

Clamp a value to an interval in JavaScript.

```js
function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

console.log(clamp(12, 0, 10));
```

Check whether a word reads the same backwards.

```python
def is_palindrome(s):
    cleaned = [ch.lower() for ch in s if ch.isalnum()]
    return cleaned == cleaned[::-1]
```

Sort a short list by hand.

```python
def bubble_sort(items):
    items = list(items)
    for i in range(len(items)):
        for j in range(len(items) - 1 - i):
            if items[j] > items[j + 1]:
                items[j], items[j + 1] = items[j + 1], items[j]
    return items
```

Test a number for primality.
