# Stock Watch: setup (15 minutes, no API keys)

Stock Watch tells you which bestsellers to reorder before they run out, and shows in ₹ what every stock-out cost.

Your store's own **Shopify Flow** writes stock changes and orders into a Google Sheet. A small script inside that sheet does the maths.
- No app is installed.
- No API key or password is shared with anyone.
- The script never connects to Shopify.

You need:
- Shopify admin access with the **Flow** app (free from Shopify)
- a Google account that can edit the sheet

---

## 1. The sheet (3 min)

1. Create a new Google Sheet, e.g. "Stock Watch – <brand>".
2. **Extensions → Apps Script**. Delete what's there, paste all of `StockWatch.gs`, and Save.
3. Back in the sheet, reload the page. A **📦 Stock Watch** menu appears. Click **Set up (once)** and allow access when Google asks.
   - It creates the tabs `Stock log`, `Order log` and `⚙️ Settings`.
   - It refreshes itself every 15 minutes.
4. **File → Settings → Time zone: (GMT+05:30) India**.
5. In **⚙️ Settings**, set your real **Lead time (days)**: how long from placing a supplier order until stock is sellable.

## 2. Flow 1: log every stock change (5 min)

Shopify admin → **Apps → Flow → Create workflow**.

- **Trigger:** `Product variant inventory quantity changed`
- **Action:** `Add row to spreadsheet`. The first time, connect the Google account that can edit the sheet.
  - **Spreadsheet URL:** the sheet's URL
  - **Tab name:** `Stock log`
  - **Row contents:** paste this line exactly as one line. Commas separate the columns.

```
{{ "now" | date: "%Y-%m-%dT%H:%M:%S%z" }},{{ productVariant.id | remove: "gid://shopify/ProductVariant/" }},{{ productVariant.sku | replace: ",", " " }},{{ product.title | replace: ",", " " }},{{ productVariant.title | replace: ",", " " }},{{ inventoryQuantityPrior }},{{ productVariant.inventoryQuantity }},{{ productVariant.price }}
```

Then **Turn on workflow**.

If Flow refuses the `"now"` part, delete just that part and leave the comma: the line then starts with `,{{ productVariant.id`. The script fills in the time itself (within 15 minutes).

## 3. Flow 2: log every order line (5 min)

**Create workflow** again.

- **Trigger:** `Order created`
- **Action:** `For each`, over `order / lineItems`
- **Inside the loop:** `Add row to spreadsheet`
  - **Spreadsheet URL:** the same sheet
  - **Tab name:** `Order log`
  - **Row contents:**

```
{{ order.createdAt }},{{ order.name }},{{ lineItemsForeachitem.variant.id | remove: "gid://shopify/ProductVariant/" }},{{ lineItemsForeachitem.sku | replace: ",", " " }},{{ lineItemsForeachitem.quantity }},{{ lineItemsForeachitem.discountedUnitPriceSet.shopMoney.amount }}
```

The loop variable may have a slightly different name in your Flow editor. If so, insert the fields with the **Add variable** button inside the loop instead of typing them.

Then **Turn on workflow**.

## 4. Check it works

- Place a test order, or change one product's stock by 1 in Shopify. Within a minute a row appears in `Stock log` (and in `Order log` for an order).
- Click **📦 Stock Watch → Refresh now**.
- Optional: in **⚙️ Settings → Daily email to**, add emails for a 9 am summary.

---

## What you get

| Tab | What it shows |
|---|---|
| 🚨 Reorder now | Every selling product that is **Out now**, **Critical** (≤ 3 days left), **Order now** (stock runs out before a new order could land) or **Order this week**. For each: stock, sales per day, days left, how many to order, the order's value, and ₹ lost to stock-outs in the last 30 days. |
| 💸 Lost sales | Every stock-out of a selling product: when it went out, when it came back, hours out, units and ₹ lost, and the top-up size. It flags a **small top-up** (less than 7 days of sales, e.g. "10 pcs") and products that **went out again within a week**. |
| 📅 Daily | For each of the last 30 days: ₹ sold, ₹ lost to stock-outs, and lost as % of demand. The title line gives the 30-day total. |

**How ₹ lost is counted:**

> hours out of stock × (normal sales per day ÷ 24) × average selling price

- **Normal sales per day** is calculated only over the time the product was in stock, so stock-outs don't drag the number down.
- **Average selling price** is what customers actually paid, after discounts.

## Good to know

- **History starts when the Flows are switched on.** Lost-sales numbers build up from that day, and sales per day settles after about a week. If you have order history in a Shopify export, paste it into `Order log` in the same column order to start with a better sales rate. **Paste only orders from before the Flows were switched on:** the Sheet doesn't drop repeated rows, so overlapping orders would count twice. Leave out cancelled and test orders, and use quantities net of refunds.
- **Stock is the total across all locations,** which is what decides whether the store shows "sold out".
- **Products selling under 0.2 a day are left out of alerts.** Change this in ⚙️ Settings.
- **The log tabs are written by Flow.** Don't sort or edit them; just let them grow. The script reads them and never changes Shopify.
