/* core.i18n.ar — Arabic dictionary (keys are the English UI strings). Add missing strings
   here; anything absent simply shows in English. Keep entries sorted by feature area. */
XR.define("core.i18n.ar", ["core.i18n"], function (i18n) {
  "use strict";
  i18n.register("ar", {
    /* shell / nav */
    "Discover": "اكتشف", "Library": "المكتبة", "Watch": "شاهد", "Creators": "الحسابات", "Collections": "المجموعات", "Insights": "إحصاءات",
    "Settings": "الإعدادات", "Import": "استيراد", "More": "المزيد", "Back": "رجوع", "Search": "بحث", "Search your library…  ( / )": "ابحث في مكتبتك…  ( / )",
    "Command palette": "لوحة الأوامر", "Lock now (shift+L)": "قفل الآن (shift+L)", "Lock": "قفل", "Mute / unmute": "كتم / إلغاء الكتم", "Focus search": "الانتقال إلى البحث",
    "Go to ": "اذهب إلى ", "Go to Discover": "اذهب إلى اكتشف", "Go to Library": "اذهب إلى المكتبة", "Keyboard shortcuts": "اختصارات لوحة المفاتيح", "Show shortcuts": "عرض الاختصارات",
    "Toggle privacy blur": "تبديل تمويه الخصوصية", "Toggle dark / light theme": "تبديل الوضع الداكن / الفاتح", "Toggle discreet tab title": "تبديل عنوان التبويب المحايد",
    "Nothing here": "لا شيء هنا", "Reload": "إعادة التحميل", "Close (Esc)": "إغلاق (Esc)", "Done": "تم", "Cancel": "إلغاء", "Open": "فتح", "Save": "حفظ", "Delete": "حذف", "Remove": "إزالة", "Undo": "تراجع", "Retry": "إعادة المحاولة",
    "{n} posts": "{n} منشورًا", "one post": "منشور واحد", "posts": "منشورات", "{n} videos": "{n} فيديو", "{n} photos": "{n} صورة", "{n} creators": "{n} حسابًا", "{n} of footage": "{n} من المقاطع", "Night owl": "يا ساهر الليل",
    "Everything stays in this browser. Nothing is sent anywhere.": "كل شيء يبقى في هذا المتصفح. لا يُرسل أي شيء إلى أي مكان.",
    "Starting…": "جارٍ البدء…", "Opening local storage…": "فتح التخزين المحلي…", "Loading your activity…": "تحميل نشاطك…", "Reading posts…": "قراءة المنشورات…", "Building the interface…": "بناء الواجهة…",

    /* discover */
    "Good morning": "صباح الخير", "Good afternoon": "مساء الخير", "Good evening": "مساء الخير", "Good night": "ليلة سعيدة",
    "Your private feed": "خلاصتك الخاصة", "What would you like to watch tonight?": "ماذا تودّ أن تشاهد الليلة؟", "{n} posts you haven't opened yet": "{n} منشورًا لم تفتحها بعد",
    "Shuffle play": "تشغيل عشوائي", "Unseen shorts": "مقاطع قصيرة لم تُشاهد", "Starred": "المميزة بنجمة", "Continue watching": "متابعة المشاهدة", "Pick up where you stopped": "أكمل من حيث توقفت",
    "Let the next clip find you.": "دع المقطع التالي يجدك.", "Start watching": "ابدأ المشاهدة", "Jump back in": "عُد إلى حيث كنت", "Spotlight": "تحت الضوء", "Newest unseen": "الأحدث غير المُشاهد",
    "Shorts for you": "مقاطع قصيرة لك", "Unseen clips, shuffled daily": "مقاطع لم تُشاهد، تُخلط يوميًا", "Recently saved": "المحفوظة مؤخرًا", "Long form": "مقاطع طويلة", "Clips over 3 minutes": "مقاطع تتجاوز 3 دقائق",
    "Photo stories": "قصص مصوّرة", "Multi-image posts": "منشورات متعددة الصور", "Single stills": "صور مفردة", "On this day": "في مثل هذا اليوم", "Same date, earlier years": "نفس التاريخ في سنوات سابقة",
    "Random picks": "اختيارات عشوائية", "A fresh shuffle every day": "خلطة جديدة كل يوم", "Unseen posts from creators you keep opening": "منشورات لم تُشاهد من حسابات تفتحها كثيرًا", "Most liked": "الأكثر إعجابًا",
    "Watch all": "شاهد الكل", "All": "الكل", "See all": "عرض الكل", "Reshuffle": "إعادة الخلط", "Reshuffle Discover": "إعادة خلط اكتشف", "Shuffle more": "خلط المزيد", "Nothing to watch here": "لا شيء للمشاهدة هنا",

    /* library */
    "Explore your library": "استكشف مكتبتك", "Search… try  @user  #tag  is:short  dur:>5m  likes:>10k  sort:likes": "ابحث… جرّب  @user  #tag  is:short  dur:>5m",
    "Search syntax": "صيغة البحث", "Filters": "التصفية", "Videos": "فيديوهات", "Shorts": "قصيرة", "Long": "طويلة", "Photos": "صور", "Albums": "ألبومات", "GIFs": "صور متحركة", "Text posts": "منشورات نصية",
    "Unseen": "لم تُشاهد", "Seen": "تمت مشاهدتها", "In progress": "قيد المشاهدة", "Hidden": "مخفية", "Unavailable": "غير متاحة", "Duplicates": "مكررة",
    "Any month posted": "أي شهر نُشر فيه", "Any month saved": "أي شهر حُفظ فيه", "Recently saved": "المحفوظة مؤخرًا", "Newest": "الأحدث", "Oldest": "الأقدم", "Most liked": "الأكثر إعجابًا", "Most viewed": "الأكثر مشاهدة", "Longest": "الأطول", "Shortest": "الأقصر", "Shuffle": "عشوائي", "By creator": "حسب الحساب",
    "Clear all": "مسح الكل", "Clear filters": "مسح التصفية", "Save this view": "حفظ هذا العرض", "Save current view…": "حفظ العرض الحالي…", "Saved views": "العروض المحفوظة", "Delete a view…": "حذف عرض…", "View saved": "تم حفظ العرض",
    "No posts match": "لا توجد منشورات مطابقة", "Nothing matches right now": "لا شيء مطابق حاليًا", "Everything": "كل شيء", "Star": "نجمة", "Unstar": "إزالة النجمة", "Hide": "إخفاء", "Hide post": "إخفاء المنشور", "Unhide": "إظهار", "Add to collection": "إضافة إلى مجموعة", "Add to collection (c)": "إضافة إلى مجموعة (c)",
    "Open on X": "فتح في X", "Open on X (o)": "فتح في X (o)", "Copy link": "نسخ الرابط", "Copy caption": "نسخ النص", "Open media file": "فتح ملف الوسائط", "Download": "تنزيل", "Watch from here": "شاهد من هنا", "View": "عرض", "Related": "ذات صلة",

    /* watch */
    "Star (s)": "نجمة (s)", "Mute (m)": "كتم (m)", "Muted": "مكتوم", "Sound": "الصوت", "Speed": "السرعة", "Fit": "الملاءمة", "Fill": "ملء", "Fullscreen (f)": "ملء الشاشة (f)", "Next": "التالي", "Next (→)": "التالي (→)", "Previous (←)": "السابق (←)", "Up next": "التالي في القائمة", "Queue": "قائمة التشغيل",
    "This media is no longer available on X": "هذه الوسائط لم تعد متاحة على X", "Nothing to watch": "لا شيء للمشاهدة", "Import posts or pick a list from Discover or Library.": "استورد منشورات أو اختر قائمة من اكتشف أو المكتبة.", "No unseen shorts left": "لم تتبقَّ مقاطع قصيرة غير مُشاهدة",
    "Browsers block autoplay with sound until you interact": "تمنع المتصفحات التشغيل التلقائي مع الصوت حتى تتفاعل مع الصفحة", "Watch gestures: swipe or wheel to move · tap to pause · double-tap to star · hold for 2× · drag sideways to seek.": "إيماءات المشاهدة: اسحب أو استخدم العجلة للتنقل · انقر للإيقاف · انقر مرتين للنجمة · اضغط مطولًا للسرعة 2× · اسحب جانبيًا للتقديم.",

    /* creators / collections */
    "{n} accounts in your library": "{n} حسابًا في مكتبتك", "Filter creators…": "تصفية الحسابات…", "Most saved": "الأكثر حفظًا", "Recent": "الأحدث", "A–Z": "أ–ي", "All creators": "كل الحسابات", "Posts": "منشورات", "In Library": "في المكتبة",
    "All collections": "كل المجموعات", "New collection": "مجموعة جديدة", "Create": "إنشاء", "Name": "الاسم", "Rename…": "إعادة تسمية…", "Rename collection": "إعادة تسمية المجموعة", "Collection not found": "المجموعة غير موجودة", "Empty collection": "مجموعة فارغة",
    "Add posts from any tile's ⋯ menu, or press c while watching.": "أضف منشورات من قائمة ⋯ لأي بطاقة، أو اضغط c أثناء المشاهدة.", "Starred, in progress, and your own lists": "المميزة بنجمة، قيد المشاهدة، وقوائمك الخاصة", "Recently seen": "شوهدت مؤخرًا", "Nothing in progress": "لا شيء قيد المشاهدة", "Gone from X bookmarks": "لم تعد في إشارات X المرجعية",

    /* insights */
    "{n} media posts · {h} h of video": "{n} منشور وسائط · {h} ساعة فيديو", "What you save": "ما تحفظه", "Posted per month": "المنشور شهريًا", "Saved per month": "المحفوظ شهريًا", "Video length": "مدة الفيديو", "Top creators": "أبرز الحسابات", "Top hashtags": "أبرز الوسوم",
    "Creators you open most": "الحسابات التي تفتحها أكثر", "When posts were published": "متى نُشرت المنشورات", "Hour of day": "ساعة اليوم", "Weekday": "يوم الأسبوع", "Orientation": "الاتجاه", "Vertical": "عمودي", "Square": "مربع", "Landscape": "أفقي", "Most liked posts": "أكثر المنشورات إعجابًا",
    "Long videos": "فيديوهات طويلة", "Footage": "مقاطع", "Albums": "ألبومات", "Click a bar to open that month.": "انقر على عمود لفتح ذلك الشهر.", "Based on what you watched here.": "استنادًا إلى ما شاهدته هنا.", "Duplicates": "مكررة", "{n} groups of posts share the same media": "{n} مجموعات من المنشورات تشترك في نفس الوسائط",

    /* settings */
    "Appearance": "المظهر", "Theme": "السمة", "Dark": "داكن", "Light": "فاتح", "Auto": "تلقائي", "System": "النظام", "Accent": "اللون المميز", "Density": "الكثافة", "Compact": "مضغوط", "Cozy": "مريح", "Roomy": "واسع", "Tile size in grids": "حجم البطاقات في الشبكات",
    "Tile shape": "شكل البطاقة", "Natural": "طبيعي", "Portrait": "عمودي", "Tile details": "تفاصيل البطاقة", "Creator and caption on tiles": "الحساب والنص على البطاقات", "On hover": "عند التمرير", "Always": "دائمًا", "Never": "أبدًا", "Dim seen posts": "تعتيم المنشورات المُشاهدة",
    "Hover preview": "معاينة عند التمرير", "Play a muted preview when the mouse rests on a video tile": "تشغيل معاينة صامتة عندما يستقر المؤشر على بطاقة فيديو", "Reduce motion": "تقليل الحركة", "On": "تشغيل", "Off": "إيقاف", "Start on": "ابدأ على", "Language": "اللغة", "Follows the browser language": "تتبع لغة المتصفح",
    "Playback": "التشغيل", "Tiles open in": "تفتح البطاقات في", "Shift-click a tile for the other one": "اضغط Shift مع النقر للخيار الآخر", "Viewer": "العارض", "Watch feed": "خلاصة المشاهدة", "Autoplay": "تشغيل تلقائي", "Start muted": "البدء مكتومًا", "Loop short clips": "تكرار المقاطع القصيرة",
    "Clips up to 60 s repeat instead of advancing": "المقاطع حتى 60 ثانية تتكرر بدل الانتقال", "Auto-advance": "انتقال تلقائي", "Move to the next post when a video ends": "الانتقال إلى المنشور التالي عند انتهاء الفيديو", "Images auto-advance": "انتقال تلقائي للصور", "Seconds before the feed moves past a photo (0 = never)": "الثواني قبل تجاوز الصورة (0 = أبدًا)",
    "Auto = fill the screen for vertical clips on phones, letterbox elsewhere": "تلقائي = ملء الشاشة للمقاطع العمودية على الهاتف، وإطار أسود في غير ذلك", "Remember position": "تذكّر الموضع", "Resume long videos where you left them": "استئناف الفيديوهات الطويلة من حيث توقفت", "Preload neighbours": "تحميل مسبق للمجاور", "Warm up the next clip while you watch": "تهيئة المقطع التالي أثناء المشاهدة",
    "One post per wheel notch": "منشور واحد لكل حركة عجلة", "Off = free scrolling with a mouse wheel": "إيقاف = تمرير حر بعجلة الفأرة", "Threshold between Shorts and Long videos": "الحد الفاصل بين المقاطع القصيرة والطويلة",
    "Privacy": "الخصوصية", "Blur thumbnails": "تمويه الصور المصغرة", "Grids and rails are blurred until you hover or tap (shift+B)": "تُموَّه الشبكات والصفوف حتى التمرير أو النقر (shift+B)", "Discreet tab": "تبويب محايد", "Neutral title and icon in the browser tab": "عنوان وأيقونة محايدان في تبويب المتصفح",
    "Hide sensitive posts": "إخفاء المنشورات الحساسة", "Posts X marked as sensitive are kept out of every list": "المنشورات التي وسمها X كحساسة تُستبعد من كل القوائم", "PIN lock": "قفل برمز PIN", "Set PIN": "تعيين رمز", "Change PIN": "تغيير الرمز", "Remove PIN": "إزالة الرمز", "Set a PIN": "تعيين رمز PIN", "PIN enabled": "تم تفعيل الرمز", "PIN removed": "تمت إزالة الرمز",
    "Auto-lock": "قفل تلقائي", "Lock again after the tab has been hidden for this long (0 = only on launch)": "القفل مجددًا بعد إخفاء التبويب لهذه المدة (0 = عند التشغيل فقط)", "Set a PIN in Settings → Privacy first": "عيّن رمز PIN من الإعدادات ← الخصوصية أولًا", "Enter your PIN": "أدخل رمز PIN", "Unlock": "فتح القفل", "Wrong PIN": "رمز خاطئ", "Forgot PIN?": "نسيت الرمز؟",
    "Data": "البيانات", "Libraries": "المكتبات", "Switch, rename or remove the libraries stored in this browser": "بدّل بين المكتبات المخزنة في هذا المتصفح أو أعد تسميتها أو احذفها", "Import / replace": "استيراد / استبدال", "Re-read file": "إعادة قراءة الملف", "Forget imported": "نسيان المستورد", "Keep text-only posts": "إبقاء المنشورات النصية", "Show bookmarks without media (hidden by default)": "عرض الإشارات بدون وسائط (مخفية افتراضيًا)",
    "Local media folder": "مجلد الوسائط المحلي", "Media availability": "توفر الوسائط", "Check which posts still load from X. Dead ones are marked and can be hidden in one go.": "تحقق من المنشورات التي ما زالت تُحمَّل من X. تُعلَّم الميتة ويمكن إخفاؤها دفعة واحدة.", "Check now": "تحقق الآن", "Stop": "إيقاف", "Hide all unavailable": "إخفاء كل غير المتاح", "Clear marks": "مسح العلامات",
    "Your activity": "نشاطك", "Export": "تصدير", "Restore": "استعادة", "Export library": "تصدير المكتبة", "Storage": "التخزين", "Reset preferences": "إعادة ضبط التفضيلات", "Erase everything": "مسح كل شيء", "About & shortcuts": "حول والاختصارات", "Debug panel": "لوحة التشخيص", "Copy report": "نسخ التقرير",

    /* import */
    "Import posts": "استيراد المنشورات", "Upload a file": "رفع ملف", "Drop it anywhere in the app, or pick it.": "أفلته في أي مكان في التطبيق، أو اختره.", "Drop .json or .js here": "أفلت .json أو .js هنا", "or click to choose": "أو انقر للاختيار", "Paste JSON": "لصق JSON", "Copy the export's content and paste it here.": "انسخ محتوى التصدير والصقه هنا.",
    "Analyse": "تحليل", "Paste from clipboard": "لصق من الحافظة", "Put the file in the project": "ضع الملف في المشروع", "The zero-click way: XReels reads data/posts.js every time it opens.": "الطريقة بلا نقرات: يقرأ XReels الملف data/posts.js في كل مرة يُفتح.", "Re-read data/posts.js": "إعادة قراءة data/posts.js", "Download current as posts.js": "تنزيل الحالي كملف posts.js",
    "Load the sample library": "تحميل المكتبة التجريبية", "Replace": "استبدال", "Merge": "دمج", "New library": "مكتبة جديدة", "What changed": "ما الذي تغيّر", "new": "جديد", "gone": "اختفى", "changed": "تغيّر", "unchanged": "دون تغيير", "Your library is empty": "مكتبتك فارغة", "Import your X bookmarks export to get started.": "استورد تصدير إشاراتك المرجعية من X للبدء.",
    "Ready to import": "جاهز للاستيراد", "compared with": "مقارنةً بـ", "with media": "مع وسائط", "videos": "فيديوهات", "creators": "حسابات", "unreadable": "غير مقروء", "format": "الصيغة",
    "Keep the {n} posts that disappeared as a collection “Gone from X bookmarks”": "احتفظ بالمنشورات الـ{n} التي اختفت في مجموعة «لم تعد في إشارات X»", "{n} posts kept in the collection": "تم الاحتفاظ بـ{n} منشورًا في المجموعة", "Imported {n} posts": "تم استيراد {n} منشورًا",
    "Replace the active library with this file": "استبدال المكتبة النشطة بهذا الملف", "Keep posts missing from the file, add the new ones": "إبقاء المنشورات الغائبة عن الملف وإضافة الجديدة", "Store it as a separate library you can switch to": "تخزينه كمكتبة منفصلة يمكنك التبديل إليها",
    "Active": "نشطة", "Last error": "آخر خطأ", "Library removed": "تمت إزالة المكتبة", "Sample library loaded": "تم تحميل المكتبة التجريبية", "Posts reloaded": "أُعيد تحميل المنشورات", "Rename library": "إعادة تسمية المكتبة", "Copied": "تم النسخ", "English": "English",
    "Environment, boot timings and the last events — handy when reporting a problem": "البيئة وأزمنة الإقلاع وآخر الأحداث — مفيد عند الإبلاغ عن مشكلة", "Clear the cache of data/posts.js and read it again": "مسح ذاكرة data/posts.js المؤقتة وقراءته مجددًا",
    "Couldn't read that": "تعذّرت قراءة ذلك", "Couldn't read data/posts.js": "تعذّرت قراءة data/posts.js", "You've seen it all — time for a rewatch": "لقد شاهدت كل شيء — حان وقت إعادة المشاهدة", "No media posts found in this file.": "لم يُعثر على منشورات وسائط في هذا الملف.", "URL import is unavailable on file:// — use upload or paste.": "استيراد عبر الرابط غير متاح على file:// — استخدم الرفع أو اللصق.",

    /* palette */
    "Type a command, a creator, #tag, or search…": "اكتب أمرًا أو حسابًا أو #وسمًا أو ابحث…", "No matches": "لا نتائج", "Search library for “{q}”": "ابحث في المكتبة عن “{q}”", "Watch results for “{q}”": "شاهد نتائج “{q}”",
  }, { name: "العربية", dir: "rtl" });
});
