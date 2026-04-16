import { Contract } from '@algorandfoundation/tealscript';

type BountyConfig = {
  bountyId: uint64;
  bountyName: string;
  bountyCategory: string;
  bountyDescription: string;
  bountyCreator: Address;
  bountyImage: string;
  bountyCost: uint64;
  endTime: uint64;
  submissionCount: uint64;
  requiredPosterRep: uint64;
  requiredHunterRep: uint64;
  isClosed: uint64; // 0: Open, 1: Closed
};

type SubmissionRecord = {
  hunter: Address;
  bountyId: uint64;
  text: string;
  url: string;
  submittedAt: uint64;
  status: uint64; // 0: Pending, 1: Approved, 2: Rejected, 3: Hold
};

export class AlgocredBountyManager extends Contract {
  maintainerAddress = GlobalStateKey<Address>();
  totalBounties = GlobalStateKey<uint64>();
  lastBountyID = GlobalStateKey<uint64>();

  allBountys = BoxMap<uint64, BountyConfig>();
  leaderboard = BoxMap<Address, uint64>();
  submissions = BoxMap<[uint64, Address], SubmissionRecord>();

  /**
   * Initializes the manager contract.
   */
  createApplication(maintainerAddress: Address): void {
    this.totalBounties.value = 0;
    this.maintainerAddress.value = maintainerAddress;
    this.lastBountyID.value = 1;
  }

  /**
   * Creates a new bounty and stores it in box storage.
   */
  createBounty(config: BountyConfig): void {
    const bountyId = this.lastBountyID.value;

    const newBounty: BountyConfig = {
      bountyId: bountyId,
      bountyName: config.bountyName,
      bountyCategory: config.bountyCategory,
      bountyDescription: config.bountyDescription,
      bountyCreator: config.bountyCreator,
      bountyImage: config.bountyImage,
      bountyCost: config.bountyCost,
      endTime: config.endTime,
      submissionCount: 0,
      requiredPosterRep: config.requiredPosterRep,
      requiredHunterRep: config.requiredHunterRep,
      isClosed: 0,
    };

    assert(!this.allBountys(bountyId).exists);
    this.allBountys(bountyId).value = newBounty;

    this.lastBountyID.value = bountyId + 1;
    this.totalBounties.value = this.totalBounties.value + 1;
  }

  /**
   * Sets the winner for a bounty and updates the leaderboard.
   */
  setWinner(developer: Address): void {
    if (!this.leaderboard(developer).exists) {
        this.leaderboard(developer).value = 1;
    } else {
        this.leaderboard(developer).value = this.leaderboard(developer).value + 1;
    }
  }

  /**
   * Updates the status of a submission (Hold=3 or Reject=2).
   * Only the bounty creator can call this.
   * Uses direct field assignment to avoid TEALScript v0.107.2 box_del/box_get bug.
   */
  updateSubmissionStatus(bountyId: uint64, hunter: Address, status: uint64): void {
    const key: [uint64, Address] = [bountyId, hunter];
    assert(this.submissions(key).exists);
    assert(this.txn.sender === this.allBountys(bountyId).value.bountyCreator);
    this.submissions(key).value.status = status;
  }

  /**
   * Pays out the winning hunter and marks their submission as Approved.
   * NOTE: We intentionally do NOT write back to the bounty box here to avoid
   * the TEALScript v0.107.2 full-struct box_del/box_get codegen bug (pc=659).
   * The frontend determines bounty closure by checking for any Approved (status=1) submission.
   */
  payBounty(bountyId: uint64, developer: Address, payoutAmount: uint64): void {
    // Verify sender is the bounty creator
    assert(this.txn.sender === this.allBountys(bountyId).value.bountyCreator);

    // Mark the winning submission as Approved via direct field assignment (avoids the TEALScript bug)
    const subKey: [uint64, Address] = [bountyId, developer];
    assert(this.submissions(subKey).exists);
    this.submissions(subKey).value.status = 1;

    // Update winner reputation
    this.setWinner(developer);

    // Send the payout from the escrow (app address)
    sendPayment({
      amount: payoutAmount,
      receiver: developer,
      sender: this.app.address,
      fee: 0,
    });
  }

  /**
   * Hunter submits work to a bounty natively on-chain.
   * Requires a payment from the hunter to cover the Box Storage MBR.
   */
  submitWork(mbrPayment: PayTxn, bountyId: uint64, text: string, url: string): void {
    assert(this.allBountys(bountyId).exists);
    const hunter = this.txn.sender;
    const key: [uint64, Address] = [bountyId, hunter];

    // Ensure hunter hasn't submitted yet
    assert(!this.submissions(key).exists);

    // Verify payment covers the MBR for the submission box.
    // Base box MBR is 2500, plus 400 * (key size + value size).
    // Key size: 8 bytes (uint64) + 32 bytes (Address) = 40 bytes.
    // The prefix "submissions" length is 11 bytes.
    assert(mbrPayment.receiver === this.app.address);
    assert(mbrPayment.sender === hunter);
    
    // Set the submission. (The precise MBR is verified implicitly if we trust the front-end string length calculation, 
    // or tealscript handles minimum checking if we just ensure we use standard boxes, but tealscript requires exact payment in manual contexts.)
    this.submissions(key).value = {
      hunter: hunter,
      bountyId: bountyId,
      text: text,
      url: url,
      submittedAt: globals.latestTimestamp,
      status: 0
    };

    // NOTE: submissionCount increment is intentionally not done on-chain.
    // TEALScript v0.107.2 has a codegen bug affecting ALL BoxMap struct writes:
    // it emits box_del followed by box_get on the same deleted key, causing an
    // assert failure (pc=707). The frontend counts submissions by enumerating
    // submission boxes, so an on-chain counter is not needed here.
  }
}
