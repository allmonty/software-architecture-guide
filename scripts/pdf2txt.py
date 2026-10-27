"""Print the text of a PDF. Needs `pip install pypdf`; exits 2 if it is missing."""
import sys
try:
    from pypdf import PdfReader
except ImportError:
    sys.exit(2)
print("\n".join((p.extract_text() or "") for p in PdfReader(sys.argv[1]).pages))
