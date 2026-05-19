FANTASY FILMBALL — POSTER FOLDER
================================

Drop poster image files into this folder using the exact filenames below.
JPG, PNG, or WebP all work. Recommended size: 600px wide for cards, 1200px
wide for the home-page hero (separate file, see below). If a file is missing
the site falls back to the stylized text placeholder — nothing breaks.

CARD POSTERS (used everywhere — home page cards, reviews archive, related
reviews on a single review page). The filename is the film's title in lower
case with hyphens. One file covers every appearance of that film:

  the-odyssey.jpg                  → The Odyssey
  digger.jpg                       → Digger
  wild-horse-nine.jpg              → Wild Horse Nine
  project-hail-mary.jpg            → Project Hail Mary
  fjord.jpg                        → Fjord
  narnia.jpg                       → Narnia: The Magician's Nephew
  fatherland.jpg                   → Fatherland
  eisenberg-musical-comedy.jpg     → Jesse Eisenberg Musical Comedy
  dune-part-three.jpg              → Dune: Part Three
  cry-to-heaven.jpg                → Cry to Heaven
  michael.jpg                      → Michael
  all-of-a-sudden.jpg              → All of a Sudden
  the-social-reckoning.jpg         → The Social Reckoning
  sense-and-sensibility.jpg        → Sense and Sensibility
  jack-of-spades.jpg               → Jack of Spades
  disclosure-day.jpg               → Disclosure Day
  josephine.jpg                    → Josephine
  behemoth.jpg                     → Behemoth!
  entertainment-system-is-down.jpg → The Entertainment System Is Down
  saturn-return.jpg                → Saturn Return

HERO IMAGE (the BIG image at the top of a single review page — review.html).
This is separate from the card poster because a landscape still from the film
usually works better here than the vertical poster:

  the-odyssey-hero.jpg             → Hero for the current lead review

When you write a new review for a different film, change the filename in
review.html (line near "review__hero-img") to match — e.g., digger-hero.jpg.

FILE FORMAT NOTES
-----------------
- JPG works fine. WebP is ~30% smaller for the same quality if you want to
  optimize, but it's optional.
- All filenames are lowercase, hyphenated, no spaces, no apostrophes.
- The site assumes the .jpg extension. If you use .png or .webp, change the
  src attribute in the HTML to match (find/replace ".jpg" → ".png").

ADDING A NEW FILM
-----------------
1. Drop the poster file in this folder with the slug filename.
2. The slug is: lowercase, spaces → hyphens, strip punctuation.
   "All of a Sudden" → all-of-a-sudden.jpg
   "Behemoth!"       → behemoth.jpg
3. Add the film's <img> tag in the appropriate HTML file. The pattern is:
   <img src="posters/SLUG.jpg" alt="TITLE poster" class="review-card__poster"
        loading="lazy" onerror="this.style.display='none'">
