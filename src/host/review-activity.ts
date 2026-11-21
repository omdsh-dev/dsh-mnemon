export const POST_TURN_REVIEW_POLICY = Object.freeze({
  reviewThreshold: 5,
  textLengthScoreUnit: 50,
  textLengthScoreCap: 3,
  toolCountScoreUnit: 5,
  toolCountScoreCap: 2,
  toolDiversityThreshold: 3,
  toolDiversityScoreCap: 2,
  turnScore: 1,
})

export function scoreReviewActivity(activity: ReviewActivity): ReviewActivityScore {
  const policy = POST_TURN_REVIEW_POLICY
  const textLengthScore = Math.min(
    Math.floor(activity.totalUserTextLength / policy.textLengthScoreUnit),
    policy.textLengthScoreCap,
  )
  const turnScore = activity.turnCount * policy.turnScore
  const toolCallScore = Math.min(
    Math.floor(activity.toolCallCount / policy.toolCountScoreUnit),
    policy.toolCountScoreCap,
  )
  const toolDiversityScore = activity.uniqueToolCount < policy.toolDiversityThreshold
    ? 0
    : Math.min(
        activity.uniqueToolCount - policy.toolDiversityThreshold + 1,
        policy.toolDiversityScoreCap,
      )
  const score = textLengthScore + turnScore + toolCallScore + toolDiversityScore
  return {
    ...activity,
    textLengthScore,
    turnScore,
    toolCallScore,
    toolDiversityScore,
    score,
    threshold: policy.reviewThreshold,
    eligible: score >= policy.reviewThreshold,
  }
}
import type { ReviewActivity, ReviewActivityScore } from "./protocol.ts"

export type { ReviewActivity, ReviewActivityScore } from "./protocol.ts"
