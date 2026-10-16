# Test Fixtures

Synthetic document fixtures used by the test suite (contains no course material or personal data):

- `native-text.pdf` — Two-page PDF 1.4 document with selectable text, including leading zeros (`00123`).
- `image-only.pdf` — Single-page PDF 1.4 document containing a grayscale bitmap and no text layer.
- `structured.docx` — OOXML Word document containing a `Heading 1`, split text runs with preserved spaces, leading zeros, and a two-column table.
- `relationship-order.pptx` — 12-slide OOXML presentation whose `<p:sldIdLst>` slide sequence is `4, 1, 12, 2, 10, 3, 11, 5, 9, 7, 6, 8` while part filenames remain `slide1.xml` through `slide12.xml`.
