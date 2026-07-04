# Offers Engine — Mobile Spec (FlowVan)

> Status: **DRAFT / design** · Layer: KMP Compose field app (salesman) · Backend contract: `cash-van-dashboard/docs/OFFERS.md`
> The app **applies** offers during a SALE; it never invents discounts. The server is authoritative
> and re-evaluates on upload — the app's job is a faithful live preview + capturing free-item choices.

---

## 1. Offer types (how they feel to the salesman)

| Type | In the sale screen the salesman sees… |
|------|----------------------------------------|
| `ITEM_QTY_DISCOUNT` | Add ≥ N of item A → A's line shows the offer discount automatically. |
| `BUY_X_GET_Y_FREE` | Add ≥ N of item A → free item B appears as a **FREE** line. |
| `BASKET_THRESHOLD` | Reach N items from the set → invoice discount, **or** a "choose your free item" prompt. |
| `ITEM_SET_THRESHOLD` | Selected items X/Y/Z reach the qty (any/all) → discount or free item. |
| `LOYALTY_FIRST_PURCHASE` | New customer's first sale → invoice discount or free item, shown as applied. |

**Free item rule:** a free item is a normal cart line at its real price with a **100% discount**
(net 0), badged `هدية / FREE`. It still moves van stock.

---

## 2. Where it plugs in

Active sale flow = `VoucherScreen` + `VoucherViewModel` (same place the return-source work lives).
Offers apply to **SALE** vouchers (configurable per type server-side).

```
core/network/dto/OfferDto.kt          # OfferEvaluation, OfferLineAdj, FreeLine, AppliedOffer, OfferChoice
core/network/api/OfferApi.kt          # activeOffers(), evaluate()
core/domain/usecase/EvaluateOffersUseCase.kt
feature/voucher/VoucherViewModel.kt   # call evaluate on cart change, merge result into state
feature/voucher/VoucherContract.kt    # appliedOffers, freeLines, offerInvoiceDiscount, pendingChoices
feature/voucher/VoucherScreen.kt      # offer banners, FREE line rendering, choose-free-item sheet
```

---

## 3. Network layer

`OfferApi`:
```kotlin
suspend fun activeOffers(customerNumber: String, store: String?): List<OfferDto>   // GET /offers/active
suspend fun evaluate(body: EvaluateRequest): OfferEvaluationDto                     // POST /offers/evaluate
```
`EvaluateRequest { customerNumber, repId, store, inDate, lines: [{ itemNumber, itemQty, unitPrice }], chosenFreeItems: Map<offerId, itemNumber> }`

`OfferEvaluationDto` mirrors the backend (`lines[]`, `freeLines[]`, `invoiceDiscountValue`,
`appliedOffers[]`, `choicesRequired[]`). All fields nullable-with-defaults (apiJson `ignoreUnknownKeys = true`).

---

## 4. ViewModel behaviour

- On the SALE screen, after every cart mutation (debounced ~300 ms) call
  `EvaluateOffersUseCase(cart, customer, store)`.
- Merge the result into state:
  - apply `lines[].discount` onto the matching cart lines (display only — server re-derives),
  - render `freeLines` as read-only FREE cart lines (not user-editable; removed automatically if the trigger is no longer met),
  - keep `offerInvoiceDiscount` for the totals card,
  - set `appliedOffers` (for the banner) and `pendingChoices` (for the choose-free-item sheet).
- Totals shown to the salesman must equal what the server will compute (single rounding rule).
- **Do not** persist offer discounts into the local `InvoiceEntity` as manual discounts; instead
  tag offer-driven lines so sync sends the cart + `chosenFreeItems`, and the **server applies** the
  offer (authoritative). The printed/synced voucher reflects the server result.

State additions (`VoucherState`):
```kotlin
val appliedOffers: List<AppliedOffer> = emptyList(),
val freeLines: List<FreeLine> = emptyList(),
val offerInvoiceDiscount: Double = 0.0,
val pendingChoices: List<OfferChoice> = emptyList(),   // offers needing a free-item pick
val isEvaluatingOffers: Boolean = false,
```

---

## 5. UI

- **Applied-offers banner** above the cart: chips per applied offer (e.g. *"خصم 10% — عرض الصيف"*, *"+ هدية: ماء 500"*).
- **FREE lines** render inside the cart with a green `هدية` badge, price struck-through, net 0, no qty editor.
- **Choose-free-item sheet:** when `pendingChoices` is non-empty (type 3 list), show a bottom sheet of `choices`; the pick goes into `chosenFreeItems` and re-evaluates.
- **Totals card** shows an "Offers" discount row when `offerInvoiceDiscount > 0`.
- Loyalty (type 5) shows a one-line "عميل جديد — تم تطبيق العرض" note.

---

## 6. Sync & offline

- **Online (preferred):** evaluate live; on save the server re-applies and returns the final voucher.
- **Offline:** evaluation uses the **cached** `activeOffers` (refreshed with the catalog) to preview;
  the cart + `chosenFreeItems` are stored and pushed via `/sync/vouchers`. The **server is the final
  arbiter** at promotion — if an offer no longer qualifies, the posted voucher won't include it (the
  app reconciles on the next catalog/voucher refresh).
- Free lines are part of the synced `transactions` (price + 100% discount) so the number/stock match.
- Voucher number: app-generated and kept by the server (see `returns-reference-original-sale` behaviour) — offers don't change numbering.

---

## 7. Edge cases

- Trigger un-met after edit → matching free line + discount auto-removed.
- Free item out of stock → still added (negative stock allowed), small "low stock" hint.
- Non-stackable offers → only the best one shows; banner explains.
- Returns/orders → no offer evaluation (SALE only unless a type opts in).
- Never show a line/total below 0.

## 8. Acceptance

- Each of the 5 types previews correctly and matches the server result on post.
- FREE lines show 100%-off, net 0, and post with the voucher.
- Choose-free-item sheet drives type-3 list rewards.
- Offline preview from cache; server reconciles on sync.
