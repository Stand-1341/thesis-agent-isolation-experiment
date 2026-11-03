# Changes required to make the full thesis consistent with Azure-only testing

**Use a copy** of `01-FULL-THESIS-ORIGINAL.docx`. Keep the original as received.

- [ ] **Abstract:** Describe actual cloud testbeds (Azure Linux VM, Azure Functions, Azure Container Apps custom sessions), not generic provider assumptions. Do not imply data already collected.
- [ ] **Chapter 1:** Update scope and delimitation statements if they identify provider services.
- [ ] **Chapter 2:** Add accurate citations for Azure Functions and Hyper-V custom sessions; distinguish service models and isolation mechanism. Do not equate Hyper-V with Firecracker.
- [ ] **Chapter 3, Research Environment and Tools:** Replace Hetzner/Cloudflare with precise Azure services, regions, SKUs, runtime versions, and adapter differences.
- [ ] **Table 2:** Explicitly state VM service; Azure Functions hosting plan; Azure custom-session pool and E16 quota; feasible enforcement mechanisms for P1/P2/P3.
- [ ] **Figure 1:** Replace all three architecture labels. Keep trusted controller, independent verification and external authorization.
- [ ] **Paragraph about expired student benefits:** Remove or update the statement that AWS/Azure cannot be used; record current funding situation correctly.
- [ ] **Permission profiles P1/P2/P3:** Describe exact Azure enforcement, including Flex Consumption VNet route/NSG if used and the custom-pool P3 limitation. Do not conflate application URL checks with network-level prevention.
- [ ] **Compatibility pilot:** Record explicit pass/fail evidence before freezing the protocol. Update if a control is unsupported.
- [ ] **450 versus 490:** The original design is 3 x 3 x 10 x 5 = 450. Keep setup/retries and any additional 40 distinct unless preregistered and justified.
- [ ] **LLM selection:** Preserve the deterministic baseline separately. User has selected a matched GPT-5 mini `low` live-agent phase with model fallback disabled; the 450-row live-arm protocol remains a draft requiring prompt/tool hashes, a fixed schedule, cost guard, and separate metrics/results.
- [ ] **Chapter 4:** Replace all instructor placeholders only with independently verified real outcomes. Do not prefill conclusions.
- [ ] **Chapter 5:** Discuss measured observations, tied outcomes, cloud-specific confounding, and inability to generalize to unrelated provider/tenant exploits.
- [ ] **References:** Add Microsoft Learn references with access dates and preserve legitimate original sources as applicable.
- [ ] **Final submission QA:** Check page numbers, table/figure references, headings, bibliography, dissertation committee guidance and appendices.
