# Algocred
#  Dual‑Reputation Bounties & Payroll on Algorand

AlgoCred is a dApp module for **crypto bounties and payroll** where **both contributors and bounty‑posters** build portable, verifiable reputation from each completed task.


**Live Demo**: [https://algocred-liart.vercel.app/](https://algocred-liart.vercel.app/)

application ID 
758914041

monitor at
https://testnet.explorer.perawallet.app/application/758914041/


For every completed bounty:

- Worker rates employer, and employer rates worker.  
- **Payout timing** (on‑time vs delayed) is recorded.  
- A reputation smart contract aggregates these events into role‑aware scores for each address.  

A batch payroll engine uses **Algorand atomic transaction groups** to pay many wallets in a single all‑or‑nothing operation, reducing operational risk and saving total network fees compared to sending individual transfers on top of Algorand’s already low per‑transaction costs.

---

## Key Features

### Dual‑Sided Reputation

- On‑chain scores for **contributors** and **employers**.  
- Ratings plus payout delay metrics feed reliability and fairness scores over time.  
- Public, queryable profiles for each address.

### Bounty Workflows

- Create bounties with reward, deadline, and acceptance criteria.  
- Contributors apply and submit work through a guided flow.  
- Posters review, approve, or request changes from a unified dashboard.

### Atomic Batch Payroll

- Build lists of `(address, amount, asset)` for contractors and employees.  
- Use **Algorand atomic transaction groups** so all payouts in the batch succeed or all fail (no partial payroll).
