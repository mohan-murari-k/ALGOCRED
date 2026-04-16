'use client'

import React, { useState, useEffect } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import algosdk from 'algosdk'
import { NeonButton, GlowingCard, CyberBadge } from '@/components/cyber-ui'
import { useWallet } from '@/lib/wallet-context'
import { Loader2 } from 'lucide-react'
import { AlgocredBountyManagerFactory } from '@/contracts/AlgocredBountyManagerClient'
import { CursorGlow } from '@/components/root-layout-client'

// ── Helpers ──────────────────────────────────────────────────────────────────

function getAlgorand() {
  return AlgorandClient.fromConfig({
    algodConfig: { server: 'https://testnet-api.algonode.cloud', port: '', token: '' },
    indexerConfig: { server: 'https://testnet-idx.algonode.cloud', port: '', token: '' },
  })
}

function getAppId() {
  return Number(process.env.NEXT_PUBLIC_MANAGER_APP_ID)
}

function getClient(algorand: ReturnType<typeof getAlgorand>, sender: string, signer: algosdk.TransactionSigner) {
  const appId = getAppId()
  const factory = new AlgocredBountyManagerFactory({ algorand, defaultSender: sender, defaultSigner: signer })
  return factory.getAppClientById({ appId: BigInt(appId) })
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function BountyDetailPage() {
  const params = useParams()
  const { connected, activeAccount, transactionSigner } = useWallet()

  const [activeTab, setActiveTab] = useState<'details' | 'submissions'>('details')
  const [bounty, setBounty] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [showSubmitModal, setShowSubmitModal] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [payoutInProgress, setPayoutInProgress] = useState(false)
  const [submissions, setSubmissions] = useState<any[]>([])

  const isOwner = connected && activeAccount?.address === bounty?.posterId

  // ── Fetch bounty + submissions from on-chain ──────────────────────────────
  useEffect(() => {
    async function fetchBounty() {
      const appId = getAppId()
      if (!appId || !params.id) { setLoading(false); return }

      try {
        const algorand = getAlgorand()
        const bountyIdNum = Number(params.id)

        // ── Bounty data ──
        const boxName = algosdk.encodeUint64(bountyIdNum)
        const boxValue = await algorand.client.algod.getApplicationBoxByName(appId, boxName).do()
        const abiType = algosdk.ABIType.from('(uint64,string,string,string,address,string,uint64,uint64,uint64,uint64,uint64,uint64)')
        const decoded = abiType.decode(boxValue.value) as any[]

        setBounty({
          id: String(decoded[0]),
          title: String(decoded[1]),
          category: String(decoded[2]),
          description: String(decoded[3]),
          posterId: String(decoded[4]),
          poster: { displayName: String(decoded[4]).substring(0, 8) + '...' },
          imageUrl: String(decoded[5]),
          reward: Number(decoded[6]) / 1e6,
          deadline: new Date(Number(decoded[7]) * 1000).toLocaleDateString(),
          applicants: Number(decoded[8]),
          isClosed: false, // Derived from submissions below after we fetch them
        })

        // ── Submissions from on-chain boxes ──
        const boxResponse = await algorand.client.algod.getApplicationBoxes(appId).do()
        const boxes = boxResponse.boxes || []

        const bountyIdBytes = algosdk.encodeUint64(bountyIdNum)

        const subs: any[] = []
        // New ABI type includes the 'status' uint64 at the end
        const submissionAbiType = algosdk.ABIType.from('(address,uint64,string,string,uint64,uint64)')

        for (const box of boxes) {
          const name = box.name // Uint8Array
          if (name.length !== 40) continue // 8 (bountyId) + 32 (Address)

          // Check if first 8 bytes match bountyId
          let match = true
          for (let i = 0; i < 8; i++) {
            if (name[i] !== bountyIdBytes[i]) { match = false; break }
          }
          if (!match) continue

          try {
            const content = await algorand.client.algod.getApplicationBoxByName(appId, name).do()
            const decodedSub = submissionAbiType.decode(content.value) as any[]
            subs.push({
              hunter_address: String(decodedSub[0]),
              submission_text: String(decodedSub[2]),
              submission_url: String(decodedSub[3]),
              submittedAt: Number(decodedSub[4]),
              status: Number(decodedSub[5]), // 0: Pending, 1: Approved, 2: Rejected, 3: Hold
            })
          } catch (e) { console.error('Error decoding sub box:', e) }
        }
        setSubmissions(subs)
        // Derive bounty closure: if any submission is Approved (status=1), bounty is closed
        const hasApproved = subs.some(s => s.status === 1)
        if (hasApproved) {
          setBounty(prev => prev ? { ...prev, isClosed: true } : prev)
        }

      } catch (err) {
        console.error('Fetch Error:', err)
      } finally {
        setLoading(false)
      }
    }
    fetchBounty()
  }, [params.id, connected])

  // ── Pay out winner ────────────────────────────────────────────────────────
  const handlePayout = async (winnerAddress: string, amount: number) => {
    if (!activeAccount?.address || !transactionSigner) {
      alert('Please connect your wallet first.')
      return
    }
    setPayoutInProgress(true)
    try {
      const algorand = getAlgorand()
      const appId = getAppId()
      const client = getClient(algorand, activeAccount.address, transactionSigner)

      // Box key for the submission: bountyId (8) + hunterPK (32)
      const bountyIdBytes = algosdk.encodeUint64(Number(params.id))
      const hunterPKBytes = algosdk.decodeAddress(winnerAddress).publicKey
      const subKey = new Uint8Array(40)
      subKey.set(bountyIdBytes)
      subKey.set(hunterPKBytes, 8)

      await client.send.payBounty({
        args: {
          bountyId: BigInt(params.id as string),
          developer: winnerAddress,
          payoutAmount: BigInt(Math.floor(amount * 1e6)),
        },
        boxReferences: [
          { appId: BigInt(appId), name: algosdk.encodeUint64(BigInt(params.id as string)) },
          { appId: BigInt(appId), name: subKey },
        ],
        extraFee: (1000).microAlgos(), // Cover inner payment txn fee
      })
      alert('Payout Successful! Bounty closed.')
      window.location.reload()
    } catch (e: any) {
      console.error(e)
      alert(`Payout failed: ${e?.message ?? 'Check console.'}`)
    } finally {
      setPayoutInProgress(false)
    }
  }

  const handleUpdateStatus = async (hunterAddress: string, status: number) => {
    if (!activeAccount?.address || !transactionSigner) return
    try {
      const algorand = getAlgorand()
      const appId = getAppId()
      const client = getClient(algorand, activeAccount.address, transactionSigner)

      const bountyIdBytes = algosdk.encodeUint64(BigInt(params.id as string))
      const hunterPKBytes = algosdk.decodeAddress(hunterAddress).publicKey
      const subKey = new Uint8Array(40)
      subKey.set(bountyIdBytes)
      subKey.set(hunterPKBytes, 8)

      await client.send.updateSubmissionStatus({
        args: {
          bountyId: BigInt(params.id as string),
          hunter: hunterAddress,
          status: BigInt(status),
        },
        boxReferences: [
          { appId: BigInt(appId), name: subKey },
          { appId: BigInt(appId), name: bountyIdBytes },
        ],
        extraFee: (1000).microAlgos(), // Cover box overhead if needed
      })
      alert('Status updated successfully!')
      window.location.reload()
    } catch (e: any) {
      console.error('Update failed:', e)
      alert(`Update failed: ${e?.message ?? 'Check console.'}`)
    }
  }
  
  // ── Submit work on-chain ──────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!activeAccount?.address || !transactionSigner) {
      alert('Please connect your wallet first.')
      return
    }
    setSubmitting(true)
    try {
      const url = (document.getElementById('sub-url') as HTMLInputElement).value.trim()
      const text = (document.getElementById('sub-text') as HTMLTextAreaElement).value.trim()
      if (!text) { alert('Please enter a work description.'); setSubmitting(false); return }

      const algorand = getAlgorand()
      const appId = getAppId()
      const client = getClient(algorand, activeAccount.address, transactionSigner)

      // ABI-encoded SubmissionRecord layout (TEALScript BoxMap, no key prefix):
      //   Key  : bountyId (8 bytes) + hunter pubkey (32 bytes) = 40 bytes
      //   Value head (52 bytes): hunter addr (32) | bountyId (8) | text-offset (2) | url-offset (2) | submittedAt (8)
      //   Value tail: [2-byte text length] + text bytes + [2-byte url length] + url bytes
      const baseMBR = 2500
      const keyLen = 40
      const valueLen = 52 + 2 + text.length + 2 + url.length  // head + tail (with length prefixes)
      const totalMBR = baseMBR + 400 * (keyLen + valueLen)

      // ── Build box key for reference ──
      // The box key is just bountyId (8 bytes) + hunterPK (32 bytes)
      const bountyIdBytes = algosdk.encodeUint64(Number(params.id))
      const hunterPKBytes = algosdk.decodeAddress(activeAccount.address).publicKey
      const subKey = new Uint8Array(bountyIdBytes.length + hunterPKBytes.length)
      subKey.set(bountyIdBytes)
      subKey.set(hunterPKBytes, bountyIdBytes.length)

      // ── Build MBR payment transaction (do NOT send yet) ──
      // algosdk v3 removed the positional-arg form. Use the object-arg form which still exists in v3.
      const suggestedParams = await algorand.client.algod.getTransactionParams().do()
      const mbrPaymentTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: activeAccount.address,
        receiver: algosdk.getApplicationAddress(appId),
        amount: totalMBR,
        suggestedParams,
      })

      // ── Call submitWork ──
      // The AppClient will compose the payment transaction with the app call in a group
      await client.send.submitWork({
        args: {
          mbrPayment: mbrPaymentTxn,
          bountyId: Number(params.id),
          text,
          url,
        },
        boxReferences: [
          { appId: BigInt(appId), name: subKey },
          { appId: BigInt(appId), name: bountyIdBytes },
        ],
      })

      setSubmitted(true)
      setTimeout(() => { setShowSubmitModal(false); setSubmitted(false) }, 2500)
    } catch (e: any) {
      console.error(e)
      alert(`Submission failed: ${e?.message ?? 'Check console for details.'}`)
    } finally {
      setSubmitting(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return (
    <div className="min-h-screen bg-deep-void flex flex-col items-center justify-center p-4">
      <Loader2 className="w-12 h-12 animate-spin text-electric-cyan mb-4" />
      <p className="text-xl font-bold text-electric-cyan uppercase tracking-widest">Syncing Matrix...</p>
    </div>
  )

  if (!bounty) return (
    <div className="min-h-screen bg-deep-void flex flex-col items-center justify-center p-4">
      <p className="text-xl text-neon-magenta font-bold">Bounty not found on-chain.</p>
      <Link href="/bounties" className="text-electric-cyan mt-4">← Back to Feed</Link>
    </div>
  )

  return (
    <div className="min-h-screen bg-deep-void p-4 lg:p-8 relative">
      <CursorGlow />
      <div className="max-w-6xl mx-auto relative z-10">
        <Link href="/bounties" className="text-muted-silver hover:text-electric-cyan mb-6 inline-block">← Back to Feed</Link>

        <div className="grid lg:grid-cols-3 gap-8">
          {/* ── Main Content ── */}
          <div className="lg:col-span-2 space-y-6">
            <GlowingCard glow="cyan">
              <div className="flex gap-2 mb-4">
                <CyberBadge variant="cyan">{bounty.category}</CyberBadge>
                <CyberBadge variant={bounty.isClosed ? 'magenta' : 'success'}>
                  {bounty.isClosed ? 'Closed' : 'Open'}
                </CyberBadge>
              </div>
              <h1 className="text-3xl font-black text-foreground mb-6">{bounty.title}</h1>

              <div className="flex gap-8 mb-8 py-4 border-y border-electric-cyan/10 text-sm">
                <div>
                  <p className="text-muted-silver uppercase">Posted By</p>
                  <p className="font-bold text-foreground font-mono text-xs">{bounty.poster.displayName}</p>
                </div>
                <div>
                  <p className="text-muted-silver uppercase">Deadline</p>
                  <p className="font-bold text-neon-magenta">{bounty.deadline}</p>
                </div>
              </div>

              {/* Owner tab switcher */}
              {isOwner && (
                <div className="flex gap-6 mb-6 border-b border-electric-cyan/20">
                  <button
                    onClick={() => setActiveTab('details')}
                    className={`pb-3 font-bold uppercase tracking-widest text-xs ${activeTab === 'details' ? 'text-electric-cyan border-b-2 border-electric-cyan' : 'text-muted-silver'}`}
                  >Details</button>
                  <button
                    onClick={() => setActiveTab('submissions')}
                    className={`pb-3 font-bold uppercase tracking-widest text-xs ${activeTab === 'submissions' ? 'text-neon-magenta border-b-2 border-neon-magenta' : 'text-muted-silver'}`}
                  >Submissions ({submissions.length})</button>
                </div>
              )}

              {activeTab === 'details' ? (
                <div className="prose prose-invert max-w-none">
                  <p className="text-muted-silver whitespace-pre-wrap">{bounty.description}</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {submissions.length === 0 && (
                    <p className="text-muted-silver text-sm text-center py-8">No submissions yet.</p>
                  )}
                  {submissions.map((s, i) => (
                    <div key={i} className={`p-4 bg-deep-void/50 border rounded flex justify-between items-start gap-4 ${s.status === 1 ? 'border-toxic-green/50' : s.status === 2 ? 'border-neon-magenta/50' : 'border-electric-cyan/20'}`}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="text-xs text-electric-cyan font-mono truncate">{s.hunter_address}</p>
                          {s.status === 0 && <CyberBadge variant="cyan">Pending</CyberBadge>}
                          {s.status === 1 && <CyberBadge variant="success">Approved</CyberBadge>}
                          {s.status === 2 && <CyberBadge variant="magenta">Rejected</CyberBadge>}
                          {s.status === 3 && <CyberBadge variant="magenta">Hold</CyberBadge>}
                        </div>
                        <p className="text-sm text-foreground whitespace-pre-wrap break-words">{s.submission_text}</p>
                        {s.submission_url && (
                          <a href={s.submission_url} target="_blank" rel="noopener noreferrer" className="text-xs text-acid-purple underline mt-1 block truncate">
                            {s.submission_url}
                          </a>
                        )}
                      </div>

                      {/* Rejected: no actions possible; Approved: bounty closed; others: show relevant actions */}
                      {isOwner && !bounty.isClosed && s.status !== 2 && s.status !== 1 && (
                        <div className="flex flex-col gap-2 shrink-0">
                          {/* Approve is always available unless already Rejected */}
                          <NeonButton size="sm" onClick={() => handlePayout(s.hunter_address, bounty.reward)} loading={payoutInProgress}>
                            ✓ Approve & Payout
                          </NeonButton>
                          <div className="flex gap-1">
                            {/* Hold: can still approve or reject later */}
                            {s.status !== 3 && (
                              <button
                                onClick={() => handleUpdateStatus(s.hunter_address, 3)}
                                className="px-2 py-1 text-[10px] font-bold uppercase border border-warning-amber/50 text-warning-amber hover:bg-warning-amber/10 transition-colors rounded"
                              >
                                Hold
                              </button>
                            )}
                            {/* Reject: permanently locks this submission */}
                            <button
                              onClick={() => handleUpdateStatus(s.hunter_address, 2)}
                              className="px-2 py-1 text-[10px] font-bold uppercase border border-neon-magenta/50 text-neon-magenta hover:bg-neon-magenta/10 transition-colors rounded"
                            >
                              Reject
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </GlowingCard>
          </div>

          {/* ── Sidebar ── */}
          <div className="space-y-6">
            <GlowingCard glow="magenta" className="text-center">
              <p className="text-xs text-muted-silver uppercase mb-1">Reward</p>
              <p className="text-4xl font-black text-foreground mb-6">{bounty.reward} ALGO</p>
              {!isOwner && !bounty.isClosed && (
                <div className="space-y-3">
                  <NeonButton className="w-full" onClick={() => setShowSubmitModal(true)}>Submit Work</NeonButton>
                  <NeonButton variant="outline" className="w-full" onClick={() => {
                    const saved = JSON.parse(localStorage.getItem('saved_bounties') || '[]')
                    if (!saved.includes(params.id)) {
                      saved.push(params.id)
                      localStorage.setItem('saved_bounties', JSON.stringify(saved))
                      alert('Bounty Saved!')
                    } else {
                      alert('Already saved!')
                    }
                  }}>Save for Later</NeonButton>
                </div>
              )}
            </GlowingCard>

            <GlowingCard glow="cyan">
              <h3 className="text-electric-cyan font-bold uppercase tracking-widest mb-4 text-sm">Quick Info</h3>
              <div className="space-y-4">
                <div>
                  <p className="text-xs text-muted-silver uppercase mb-1">Posted By</p>
                  <p className="font-bold text-foreground text-xs truncate">{bounty.posterId}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-silver uppercase mb-1">Applicants</p>
                  <p className="font-bold text-foreground">{bounty.applicants}</p>
                </div>
              </div>
            </GlowingCard>

            <GlowingCard glow="purple">
              <h3 className="text-acid-purple font-bold uppercase tracking-widest mb-3 text-sm">Share</h3>
              <button
                onClick={() => { navigator.clipboard.writeText(window.location.href); alert('Link copied!') }}
                className="text-electric-cyan hover:text-neon-magenta text-sm transition-colors uppercase font-bold tracking-tighter"
              >
                [ Copy Magic Link ]
              </button>
            </GlowingCard>
          </div>
        </div>
      </div>

      {/* ── Submit Modal ── */}
      {showSubmitModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-deep-void/90 backdrop-blur-sm" onClick={() => !submitting && setShowSubmitModal(false)} />
          <div className="relative w-full max-w-lg">
            <GlowingCard glow="cyan">
              {submitted ? (
                <div className="text-center py-8">
                  <div className="text-5xl mb-4">✓</div>
                  <h2 className="text-2xl font-black text-toxic-green mb-2">Submission Recorded On-Chain!</h2>
                  <p className="text-muted-silver">The bounty poster will review your work shortly.</p>
                </div>
              ) : (
                <>
                  <h2 className="text-xl font-black text-electric-cyan mb-1">Submit Your Work</h2>
                  <p className="text-xs text-muted-silver mb-4">A small ALGO fee will be charged to store your submission on-chain.</p>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-bold text-electric-cyan mb-2 uppercase tracking-widest">
                        Work Description
                      </label>
                      <textarea
                        id="sub-text"
                        className="w-full h-24 bg-deep-void border border-electric-cyan/50 text-foreground px-3 py-2 focus:outline-none focus:border-electric-cyan transition-colors resize-none"
                        placeholder="Describe what you've completed..."
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-electric-cyan mb-2 uppercase tracking-widest">
                        Proof / Link
                      </label>
                      <input
                        id="sub-url"
                        type="text"
                        className="w-full bg-deep-void border border-electric-cyan/50 text-foreground px-3 py-2 focus:outline-none focus:border-electric-cyan transition-colors"
                        placeholder="GitHub repo, demo link, etc."
                      />
                    </div>
                  </div>
                  <div className="flex gap-3 mt-6">
                    <NeonButton variant="outline" onClick={() => setShowSubmitModal(false)} disabled={submitting}>
                      Cancel
                    </NeonButton>
                    <NeonButton className="flex-1" onClick={handleSubmit} loading={submitting}>
                      {submitting ? 'Signing & Submitting...' : 'Submit Work On-Chain'}
                    </NeonButton>
                  </div>
                </>
              )}
            </GlowingCard>
          </div>
        </div>
      )}
    </div>
  )
}
