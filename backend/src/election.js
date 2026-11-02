function courseFromBlock(block) {
  const match = String(block || "").trim().match(/^([a-z]+)/i);
  return match ? match[1].toUpperCase() : "";
}

function isRepresentativePosition(position) {
  return String(position || "").trim().toLowerCase() === "representative";
}

function candidateRacePosition(candidate) {
  const position = String(candidate.position || "").trim();
  if (!isRepresentativePosition(position)) return position;
  const course = courseFromBlock(candidate.block);
  return course ? `Representative - ${course}` : null;
}

function candidateIsEligibleForStudent(candidate, studentBlock) {
  if (!isRepresentativePosition(candidate.position)) return true;
  const candidateCourse = courseFromBlock(candidate.block);
  return Boolean(candidateCourse && candidateCourse === courseFromBlock(studentBlock));
}

module.exports = {
  candidateIsEligibleForStudent,
  candidateRacePosition,
  courseFromBlock,
  isRepresentativePosition,
};
