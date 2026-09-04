export async function invoke(cmd: string): Promise<never> {
  throw new Error(`mock: ${cmd} is not a CrewClient method`);
}
