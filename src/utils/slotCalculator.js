export function getNextAvailableSlots(availability, count = 2) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const results = [];
  const today = new Date();

  for (let i = 1; i <= 14; i += 1) {
    if (results.length >= count) break;

    const date = new Date(today);
    date.setDate(today.getDate() + i);

    const dayName = days[date.getDay()];
    const dayData = availability?.[dayName];

    if (!dayData || !dayData.available) continue;
    if (!dayData.slots || dayData.slots.length === 0) continue;

    const dateStr = date.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });

    results.push({
      date: dateStr,
      time: dayData.slots[0],
      fullDateTime: `${dateStr} at ${dayData.slots[0]}`,
      isoDate: date.toISOString().split('T')[0],
    });
  }

  return results;
}
