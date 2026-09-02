# AI Store Manager — Project Status

آخر تحديث: 2026-09-01 (America/Detroit)

## 1. الهدف

بناء وكيل ذكي شبه مستقل لإدارة متجر Shopify تحت إشراف صاحب المتجر.

الوكيل يراقب المتجر، يحلل البيانات، ينشئ التقارير والتنبيهات، ويقترح الإجراءات. أي إجراء حساس يجب أن ينتظر موافقة بشرية واضحة قبل التنفيذ.

## 2. روابط وبيئة التشغيل

- GitHub: https://github.com/Ismaiel-Alkheder/ai-store-manager
- الفرع الرئيسي: `main`
- آخر إصدار مكتمل ومختبر: `6f89b88`
- وصف الإصدار: `Persist AI reports in SQLite`
- Railway service: `CAPABLE LITE`
- Production URL: https://capable-light-production-5cfd.up.railway.app
- Railway volume mount: `/app/data`
- قاعدة البيانات الدائمة: SQLite داخل Railway Volume

لا تضع قيم المتغيرات السرية أو كلمات المرور أو مفاتيح API في هذا الملف.

## 3. التقنيات الحالية

- Next.js `16.3.3`
- React `19.2.8`
- TypeScript strict mode
- Shopify Admin GraphQL API
- Node built-in `node:sqlite`
- OpenAI Responses API
- AI model: `gpt-5.6-luna`
- GitHub deployment إلى Railway

## 4. إعدادات التشغيل الآمن

- Fulfillment Mode: `MANUAL`
- Auto-Accept: `OFF`
- Auto-Ship: `OFF`
- لوحة الإدارة محمية بجلسة Admin.
- طلبات POST الإدارية الحساسة تتحقق من Same Origin.
- ملفات `.env*` مستبعدة من Git.
- لا تحفظ أسرارًا في GitHub أو في ملفات المشروع المتتبعة.

## 5. ما تم إنجازه

### Shopify والطلبات

- الاتصال بمتجر Shopify التجريبي يعمل.
- قراءة المنتجات والطلبات تعمل.
- Webhook إنشاء الطلبات يعمل ويحفظ الأحداث في SQLite.
- Webhooks الخاصة بطلبات التنفيذ مسجلة وتعمل.
- Webhook اكتمال توجيه الطلبات مسجل ويعمل.
- اختبار الطلب `#1044` اكتمل بالكامل وأصبح `COMPLETED`.

### Fulfillment

- إنشاء مهام Fulfillment.
- انتظار الموافقة البشرية في الوضع اليدوي.
- قبول أو رفض طلبات التنفيذ.
- تنفيذ الشحن وإعادة المحاولة عند الحاجة.
- صفحة Fulfillment Control Center تعمل.

### Inventory وRestock

- تنبيهات المخزون المنخفض.
- موافقات إعادة التخزين.
- إنشاء Restock Tasks.
- تسجيل استلام المخزون وتحديث Shopify.
- حفظ السجل والنتائج في SQLite.

### قاعدة البيانات وسجل الوكيل

- تهيئة SQLite مركزية عبر `src/lib/database.ts`.
- إصلاح تهيئة قاعدة البيانات المشتركة في Commit `09be4fe`.
- Railway Volume مربوط بالمسار `/app/data`.
- جدول `agent_events` يعمل ويجمع أحداث النظام.
- Agent Activity Log ظاهر في Dashboard.

### تقرير الذكاء الاصطناعي

- زر `Generate AI Report` / `Refresh AI Report` يعمل.
- التحليل باللغة العربية.
- التحليل للقراءة والتوصية فقط ولا يعدل Shopify.
- التقرير يحلل المنتجات والطلبات المحملة في Dashboard.
- تنسيق التقرير ينظف رموز Markdown قبل العرض.
- كل تقرير ناجح يُحفظ في جدول `ai_reports`.
- لا تُحفظ بيانات Shopify الخام داخل جدول التقارير.
- يُحفظ فقط:
  - نص التقرير.
  - النموذج المستخدم.
  - مصدر التقرير.
  - عدد المنتجات.
  - عدد الطلبات.
  - وقت الإنشاء.
- مسار قراءة السجل: `GET /api/ai/reports?limit=10`.
- آخر عشرة تقارير تظهر في `Saved Report History`.
- يمكن الضغط على تاريخ التقرير لعرضه.
- التقرير يبقى ظاهرًا بعد تحديث الصفحة.
- إنشاء التقرير يسجل حدث `AI_REPORT_GENERATED` في `agent_events`.

## 6. مسارات API المهمة

- `POST /api/ai/analyze`
- `GET /api/ai/reports?limit=10`
- `GET /api/agent-events`
- `GET /api/store-analytics`
- `GET /api/shopify/products`
- `GET /api/shopify/orders`
- `GET /api/approvals`
- `GET /api/inventory-alerts`
- `GET /api/restock-tasks`
- `GET /api/fulfillment-tasks`
- `GET /api/fulfillment-settings`

## 7. الاختبارات المؤكدة

- `npm run build` نجح بعد إصدار `6f89b88`.
- TypeScript check نجح.
- Next.js production build نجح.
- `/api/ai/analyze` ظهر كمسار Dynamic.
- `/api/ai/reports` ظهر كمسار Dynamic.
- إنشاء تقرير في Production نجح.
- حفظ التقرير في SQLite نجح.
- سجل التقارير ظهر بالتاريخ والساعة.
- فتح تقرير محفوظ من السجل نجح.
- التقرير بقي بعد تحديث الصفحة.
- حدث `AI store report generated` ظهر في Agent Activity Log.

تحذير `SQLite is an experimental feature` أثناء البناء هو تحذير من Node وليس فشلًا في البناء.

## 8. حدود صلاحيات الوكيل

### مسموح دون تنفيذ تغييرات حساسة

- قراءة بيانات المتجر.
- التحليل والتلخيص.
- اكتشاف الحالات غير الطبيعية.
- إنشاء تقارير وتنبيهات.
- اقتراح إجراءات.
- إعداد مسودات ردود للعملاء دون إرسالها.

### يحتاج موافقة بشرية قبل التنفيذ

- تغيير الأسعار أو الخصومات.
- إلغاء الطلبات.
- رد الأموال أو Refund.
- تعديل المخزون بكميات كبيرة.
- تغيير حالة Fulfillment أو شحن الطلبات تلقائيًا.
- إرسال رسائل للعملاء.
- إنشاء حملات أو إنفاق إعلاني.
- أي تغيير في الدفع أو البنك أو الأمان أو حساب الإدارة.
- الحذف الجماعي أو التعديلات الجماعية.

## 9. الخطوة التالية

المرحلة التالية المقترحة: `Proactive Daily AI Reports`.

### الهدف

جعل الوكيل ينشئ تقريرًا يوميًا تلقائيًا، ويحفظه في SQLite، ويسجل الحدث، ويظهر تنبيهًا في Dashboard عند وجود حالة تحتاج إلى انتباه.

### شروط القبول

1. التقرير المجدول يستخدم البيانات الحالية من Shopify.
2. لا ينفذ أي تغيير في المتجر.
3. يمنع إنشاء تقرير يومي مكرر لنفس اليوم.
4. يحفظ التقرير في `ai_reports` مع مصدر مثل `SCHEDULED`.
5. يسجل `AI_REPORT_GENERATED` في Agent Activity Log.
6. يظهر آخر وقت تشغيل وحالة النجاح أو الفشل في Dashboard.
7. يبقى Fulfillment في وضع `MANUAL` وAuto-Accept وAuto-Ship في وضع `OFF`.

## 10. طريقة المتابعة في محادثة جديدة

استخدم النص التالي:

```text
تابع مشروع AI Store Manager.
المستودع:
https://github.com/Ismaiel-Alkheder/ai-store-manager

اقرأ PROJECT_STATUS.md أولًا، ثم تحقق من آخر Commit على main، وابدأ من قسم "الخطوة التالية". لا تغيّر إعدادات الأمان أو تفعّل التنفيذ التلقائي دون موافقتي.
```

## 11. قاعدة تحديث هذا الملف

بعد كل مرحلة ناجحة:

1. حدّث آخر Commit.
2. انقل المهمة المكتملة إلى قسم "ما تم إنجازه".
3. سجل الاختبارات التي نجحت فعليًا فقط.
4. حدّث قسم "الخطوة التالية".
5. لا تضف أسرارًا أو قيم Environment Variables.
