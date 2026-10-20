# NEAR Hackathon notes (1–14 Nov 2026)

Tracks to select: 07 Agent Economy (primary), 08 Real-World Money, 04 Autonomous Business.
Optional: 06 AI Security if you add a function-call-key spending cap for the agent.

Submission needs: public repo + demo post on X with video/screenshots + the form on nearhackathon.com.
Rules say build *during* the window — push the first commit of this repo on/after 1 Nov 00:00 UTC.

Demo script (≤ 90s video):
1. Merchant registers with 5% commission, sets 8% for the "claude-code" channel.
2. Human links the agent to their own account.
3. Agent pays 10 NEAR. Show the one receipt: 9.2 to merchant, 0.72 to the human, 0.08 fee — and the human's balance ticking up without signing anything.
4. Open the Ledger page on that contract: the sale is there, Journal view, export CSV, click "verify" and run the near view.
5. One line: "the cashback is computed inside the payment; nobody can skip it, and every line is on-chain."

Everything runs on testnet. Budget: a few NEAR from the faucet.
