# Attribution for the committed A1 pages

The one-page PDFs in `pages/` and their keys in `keys/` come from the works below. Every other page of the A1
corpus (`corpus.json` entries with `"committed": false`) stays on the machine that runs the eval, in `evals/.cache/`,
and is never committed.

## OpenStax textbooks (CC BY 4.0)

Licensed under the Creative Commons Attribution 4.0 International License,
https://creativecommons.org/licenses/by/4.0/. Access for free at openstax.org.

| Pages | Book | Authors | Section |
|---|---|---|---|
| os-tables-1, os-figures-1 | Chemistry: Atoms First, https://openstax.org/details/books/chemistry-atoms-first | Edward J. Neth, Paul Flowers, William R. Robinson, PhD, Klaus Theopold, Richard Langley | 1.4 Measurements |
| os-tables-2 | Chemistry: Atoms First | as above | 16.3 Standard Reduction Potentials |
| os-scans-2 | Chemistry: Atoms First | as above | 17.3 Rate Laws |
| os-maths-1 | Algebra and Trigonometry, https://openstax.org/details/books/algebra-and-trigonometry | Jay Abramson | 11.8 Solving Systems with Cramer's Rule |
| os-scans-1 | Algebra and Trigonometry | as above | 11.4 Partial Fractions |
| os-maths-2 | Elementary Algebra, https://openstax.org/details/books/elementary-algebra | Lynn Marecek, MaryAnne Anthony-Smith | 8.5 Simplify Complex Rational Expressions |
| os-maths-3, os-figures-2 | College Algebra, https://openstax.org/details/books/college-algebra | Jay Abramson | 9.6 Binomial Theorem |

Changes made: each section's web page was printed to PDF (by ReadableSTEM's page builder) and one page was cut from
it; `os-scans-1` and `os-scans-2` were then rasterised and degraded to look like a scan (`pages.py scan_page`). The keys
are our transcriptions of those pages, written in the reader's Markdown and LaTeX conventions, with running headers
and footers left out. The section URLs are in `corpus.json`.

## ReadableSTEM (MIT)

`rs-code-1` is a page of ReadableSTEM's own authored study guide (`html-code-glossary`), and `image_page.md` is
ReadableSTEM's page-reading prompt, both from https://github.com/harishm17/readablestem under the MIT License.
